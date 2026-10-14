package tracing

import (
	"context"
	"reflect"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"
	"go.opentelemetry.io/otel/trace"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
)

// k8sInstrumentationName is the tracer name for the logical (internal) spans
// added by this package (k8s client, prometheus API, kubectl describe).
const k8sInstrumentationName = "github.com/zxh326/kite/pkg/tracing"

// Values of kite.k8s.source.
const (
	k8sSourceCache = "cache"
	k8sSourceAPI   = "api"
)

// k8sTraceable reports whether a logical span may be started for ctx: tracing
// is enabled and ctx already carries a valid span. Background work (informers,
// rbac sync, …) has no parent and must not become orphan root traces.
func k8sTraceable(ctx context.Context) bool {
	return Enabled() && trace.SpanContextFromContext(ctx).IsValid()
}

// k8sStartSpan starts an internal span; callers gate with k8sTraceable first.
func k8sStartSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return otel.Tracer(k8sInstrumentationName).Start(ctx, name,
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attrs...),
	)
}

// k8sEndSpan records err (if any) with Error status and ends span.
func k8sEndSpan(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}

// WrapClient instruments a controller-runtime client: every read/write gets an
// internal "k8s <Op> <Kind>" span when the call's context already carries a
// valid span. cacheBacked is true for the manager's client (reads of typed and
// PartialObjectMetadata objects are served from the informer cache) and false
// for a direct client (DISABLE_CACHE=true). Disabled tracing returns c as is.
func WrapClient(c client.Client, cacheBacked bool) client.Client {
	if !Enabled() || c == nil {
		return c
	}
	return &k8sTracedClient{Client: c, cacheBacked: cacheBacked, scheme: c.Scheme()}
}

// k8sTracedClient embeds the wrapped client so methods without I/O (Scheme,
// RESTMapper, GroupVersionKindFor, IsObjectNamespaced) pass straight through.
type k8sTracedClient struct {
	client.Client
	cacheBacked bool
	scheme      *runtime.Scheme
}

var _ client.Client = &k8sTracedClient{}

// k8sOp describes one traced client call.
type k8sOp struct {
	op          string
	gvk         schema.GroupVersionKind
	namespace   string
	name        string
	subResource string
	source      string
	attrs       []attribute.KeyValue
	// notFoundIsResult marks a NotFound error as an ordinary outcome (Get):
	// kite.k8s.not_found=true instead of an Error status.
	notFoundIsResult bool
}

// k8sRunResult wraps fn in the span described by o and returns fn's error
// unchanged. after, if non-nil, runs on success to add result attributes.
func k8sRunResult(ctx context.Context, o k8sOp, fn func(context.Context) error, after func(trace.Span)) error {
	name := "k8s " + o.op + " " + o.gvk.Kind
	attrs := make([]attribute.KeyValue, 0, 8+len(o.attrs))
	if o.namespace != "" {
		attrs = append(attrs, semconv.K8SNamespaceName(o.namespace))
	}
	if o.name != "" {
		attrs = append(attrs, attribute.String("kite.k8s.name", o.name))
	}
	attrs = append(attrs,
		attribute.String("kite.k8s.group", o.gvk.Group),
		attribute.String("kite.k8s.version", o.gvk.Version),
		attribute.String("kite.k8s.kind", o.gvk.Kind),
		attribute.String("kite.k8s.source", o.source),
	)
	if o.subResource != "" {
		name += "/" + o.subResource
		attrs = append(attrs, attribute.String("kite.k8s.subresource", o.subResource))
	}
	attrs = append(attrs, o.attrs...)

	ctx, span := k8sStartSpan(ctx, name, attrs...)
	err := fn(ctx)
	spanErr := err
	switch {
	case err == nil:
		if after != nil {
			after(span)
		}
	case o.notFoundIsResult && apierrors.IsNotFound(err):
		// An ordinary outcome for a read, not a failure of the call.
		span.SetAttributes(attribute.Bool("kite.k8s.not_found", true))
		spanErr = nil
	}
	k8sEndSpan(span, spanErr)
	return err
}

// k8sGVK resolves the GVK for span naming: the object's own GVK for
// unstructured (and PartialObjectMetadata, via apiutil), the scheme otherwise.
// A List suffix is stripped for lists so "k8s List Pod" reads naturally.
func (t *k8sTracedClient) k8sGVK(obj runtime.Object, isList bool) schema.GroupVersionKind {
	var gvk schema.GroupVersionKind
	if _, ok := obj.(runtime.Unstructured); ok {
		gvk = obj.GetObjectKind().GroupVersionKind()
	} else if t.scheme != nil {
		if g, err := apiutil.GVKForObject(obj, t.scheme); err == nil {
			gvk = g
		}
	}
	if gvk.Kind == "" {
		gvk.Kind = k8sTypeName(obj)
	}
	if isList {
		gvk.Kind = strings.TrimSuffix(gvk.Kind, "List")
	}
	return gvk
}

func k8sTypeName(obj any) string {
	tp := reflect.TypeOf(obj)
	if tp == nil {
		return "Unknown"
	}
	for tp.Kind() == reflect.Ptr {
		tp = tp.Elem()
	}
	if tp.Name() == "" {
		return "Unknown"
	}
	return tp.Name()
}

// k8sReadSource mirrors how controller-runtime v0.22.4 routes reads
// (pkg/client/client.go shouldBypassCache, Get, List): with a cache reader,
// everything is served from the cache except objects whose GVK is in
// CacheOptions.DisableFor and, unless CacheOptions.Unstructured is set,
// runtime.Unstructured objects. kite's manager uses the defaults from
// pkg/cluster/cluster.go (Unstructured: false, no DisableFor), so typed and
// PartialObjectMetadata reads hit the cache and unstructured reads the API.
func (t *k8sTracedClient) k8sReadSource(obj runtime.Object) string {
	if !t.cacheBacked {
		return k8sSourceAPI
	}
	if _, ok := obj.(runtime.Unstructured); ok {
		return k8sSourceAPI
	}
	return k8sSourceCache
}

func (t *k8sTracedClient) k8sWriteOp(op string, obj client.Object) k8sOp {
	return k8sOp{
		op:        op,
		gvk:       t.k8sGVK(obj, false),
		namespace: obj.GetNamespace(),
		name:      obj.GetName(),
		source:    k8sSourceAPI,
	}
}

// Get implements client.Reader.
func (t *k8sTracedClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.Get(ctx, key, obj, opts...)
	}
	return k8sRunResult(ctx, k8sOp{
		op:               "Get",
		gvk:              t.k8sGVK(obj, false),
		namespace:        key.Namespace,
		name:             key.Name,
		source:           t.k8sReadSource(obj),
		notFoundIsResult: true,
	}, func(ctx context.Context) error {
		return t.Client.Get(ctx, key, obj, opts...)
	}, nil)
}

// List implements client.Reader.
func (t *k8sTracedClient) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.List(ctx, list, opts...)
	}
	lo := (&client.ListOptions{}).ApplyOptions(opts)
	return k8sRunResult(ctx, k8sOp{
		op:        "List",
		gvk:       t.k8sGVK(list, true),
		namespace: lo.Namespace,
		source:    t.k8sReadSource(list),
		attrs:     k8sSelectorAttrs(lo),
	}, func(ctx context.Context) error {
		return t.Client.List(ctx, list, opts...)
	}, func(span trace.Span) {
		span.SetAttributes(attribute.Int("kite.k8s.items", meta.LenList(list)))
	})
}

func k8sSelectorAttrs(lo *client.ListOptions) []attribute.KeyValue {
	var attrs []attribute.KeyValue
	if lo.LabelSelector != nil && !lo.LabelSelector.Empty() {
		attrs = append(attrs, attribute.String("kite.k8s.label_selector", lo.LabelSelector.String()))
	}
	if lo.FieldSelector != nil && !lo.FieldSelector.Empty() {
		attrs = append(attrs, attribute.String("kite.k8s.field_selector", lo.FieldSelector.String()))
	}
	return attrs
}

// Create implements client.Writer.
func (t *k8sTracedClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.Create(ctx, obj, opts...)
	}
	return k8sRunResult(ctx, t.k8sWriteOp("Create", obj), func(ctx context.Context) error {
		return t.Client.Create(ctx, obj, opts...)
	}, nil)
}

// Update implements client.Writer.
func (t *k8sTracedClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.Update(ctx, obj, opts...)
	}
	return k8sRunResult(ctx, t.k8sWriteOp("Update", obj), func(ctx context.Context) error {
		return t.Client.Update(ctx, obj, opts...)
	}, nil)
}

// Patch implements client.Writer.
func (t *k8sTracedClient) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.Patch(ctx, obj, patch, opts...)
	}
	o := t.k8sWriteOp("Patch", obj)
	if patch != nil {
		o.attrs = append(o.attrs, attribute.String("kite.k8s.patch_type", string(patch.Type())))
	}
	return k8sRunResult(ctx, o, func(ctx context.Context) error {
		return t.Client.Patch(ctx, obj, patch, opts...)
	}, nil)
}

// Delete implements client.Writer.
func (t *k8sTracedClient) Delete(ctx context.Context, obj client.Object, opts ...client.DeleteOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.Delete(ctx, obj, opts...)
	}
	return k8sRunResult(ctx, t.k8sWriteOp("Delete", obj), func(ctx context.Context) error {
		return t.Client.Delete(ctx, obj, opts...)
	}, nil)
}

// DeleteAllOf implements client.Writer.
func (t *k8sTracedClient) DeleteAllOf(ctx context.Context, obj client.Object, opts ...client.DeleteAllOfOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.DeleteAllOf(ctx, obj, opts...)
	}
	do := (&client.DeleteAllOfOptions{}).ApplyOptions(opts)
	return k8sRunResult(ctx, k8sOp{
		op:        "DeleteAllOf",
		gvk:       t.k8sGVK(obj, false),
		namespace: do.Namespace,
		source:    k8sSourceAPI,
		attrs:     k8sSelectorAttrs(&do.ListOptions),
	}, func(ctx context.Context) error {
		return t.Client.DeleteAllOf(ctx, obj, opts...)
	}, nil)
}

// k8sApplyConfiguration is the accessor set generated apply configurations
// expose (mirrors controller-runtime's private applyConfiguration interface).
type k8sApplyConfiguration interface {
	GetName() *string
	GetNamespace() *string
	GetKind() *string
	GetAPIVersion() *string
}

// Apply implements client.Writer (server-side apply).
func (t *k8sTracedClient) Apply(ctx context.Context, obj runtime.ApplyConfiguration, opts ...client.ApplyOption) error {
	if !k8sTraceable(ctx) {
		return t.Client.Apply(ctx, obj, opts...)
	}
	o := k8sOp{op: "Apply", source: k8sSourceAPI}
	switch ac := obj.(type) {
	case runtime.Unstructured:
		// client.ApplyConfigurationFromUnstructured wraps *unstructured.Unstructured.
		o.gvk = ac.GetObjectKind().GroupVersionKind()
		if m, ok := obj.(metav1.Object); ok {
			o.namespace, o.name = m.GetNamespace(), m.GetName()
		}
	case k8sApplyConfiguration:
		if gv, err := schema.ParseGroupVersion(k8sDeref(ac.GetAPIVersion())); err == nil {
			o.gvk = gv.WithKind(k8sDeref(ac.GetKind()))
		}
		o.namespace, o.name = k8sDeref(ac.GetNamespace()), k8sDeref(ac.GetName())
	}
	if o.gvk.Kind == "" {
		o.gvk.Kind = k8sTypeName(obj)
	}
	return k8sRunResult(ctx, o, func(ctx context.Context) error {
		return t.Client.Apply(ctx, obj, opts...)
	}, nil)
}

func k8sDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Status implements client.StatusClient.
func (t *k8sTracedClient) Status() client.SubResourceWriter {
	return &k8sTracedSubResourceWriter{w: t.Client.Status(), parent: t, subResource: "status"}
}

// SubResource implements client.SubResourceClientConstructor.
func (t *k8sTracedClient) SubResource(subResource string) client.SubResourceClient {
	inner := t.Client.SubResource(subResource)
	return &k8sTracedSubResourceClient{
		k8sTracedSubResourceWriter: k8sTracedSubResourceWriter{w: inner, parent: t, subResource: subResource},
		r:                          inner,
	}
}

type k8sTracedSubResourceWriter struct {
	w           client.SubResourceWriter
	parent      *k8sTracedClient
	subResource string
}

func (s *k8sTracedSubResourceWriter) op(op string, obj client.Object) k8sOp {
	o := s.parent.k8sWriteOp(op, obj)
	o.subResource = s.subResource
	return o
}

// Create implements client.SubResourceWriter.
func (s *k8sTracedSubResourceWriter) Create(ctx context.Context, obj, subResource client.Object, opts ...client.SubResourceCreateOption) error {
	if !k8sTraceable(ctx) {
		return s.w.Create(ctx, obj, subResource, opts...)
	}
	return k8sRunResult(ctx, s.op("Create", obj), func(ctx context.Context) error {
		return s.w.Create(ctx, obj, subResource, opts...)
	}, nil)
}

// Update implements client.SubResourceWriter.
func (s *k8sTracedSubResourceWriter) Update(ctx context.Context, obj client.Object, opts ...client.SubResourceUpdateOption) error {
	if !k8sTraceable(ctx) {
		return s.w.Update(ctx, obj, opts...)
	}
	return k8sRunResult(ctx, s.op("Update", obj), func(ctx context.Context) error {
		return s.w.Update(ctx, obj, opts...)
	}, nil)
}

// Patch implements client.SubResourceWriter.
func (s *k8sTracedSubResourceWriter) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
	if !k8sTraceable(ctx) {
		return s.w.Patch(ctx, obj, patch, opts...)
	}
	return k8sRunResult(ctx, s.op("Patch", obj), func(ctx context.Context) error {
		return s.w.Patch(ctx, obj, patch, opts...)
	}, nil)
}

type k8sTracedSubResourceClient struct {
	k8sTracedSubResourceWriter
	r client.SubResourceReader
}

var _ client.SubResourceClient = &k8sTracedSubResourceClient{}

// Get implements client.SubResourceReader. Subresource reads always go to the
// API server (controller-runtime subResourceClient.Get uses the REST clients).
func (s *k8sTracedSubResourceClient) Get(ctx context.Context, obj, subResource client.Object, opts ...client.SubResourceGetOption) error {
	if !k8sTraceable(ctx) {
		return s.r.Get(ctx, obj, subResource, opts...)
	}
	o := s.op("Get", obj)
	o.notFoundIsResult = true
	return k8sRunResult(ctx, o, func(ctx context.Context) error {
		return s.r.Get(ctx, obj, subResource, opts...)
	}, nil)
}

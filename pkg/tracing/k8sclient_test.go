package tracing

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func k8sTestPod(name string, labels map[string]string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "default", Name: name, Labels: labels}}
}

func k8sTestClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(objs...).
		WithStatusSubresource(&corev1.Pod{}).
		Build()
}

func spanAttrs(s sdktrace.ReadOnlySpan) map[attribute.Key]attribute.Value {
	m := map[attribute.Key]attribute.Value{}
	for _, kv := range s.Attributes() {
		m[kv.Key] = kv.Value
	}
	return m
}

// onlySpan returns the single ended span other than the test's own parent.
func onlySpan(t *testing.T, rec *tracetest.SpanRecorder, parent trace.Span) sdktrace.ReadOnlySpan {
	t.Helper()
	var out []sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.SpanContext().SpanID() != parent.SpanContext().SpanID() {
			out = append(out, s)
		}
	}
	if len(out) != 1 {
		names := make([]string, 0, len(out))
		for _, s := range out {
			names = append(names, s.Name())
		}
		t.Fatalf("got %d spans %v, want 1", len(out), names)
	}
	if got, want := out[0].Parent().SpanID(), parent.SpanContext().SpanID(); got != want {
		t.Errorf("span parent = %s, want %s", got, want)
	}
	if out[0].SpanKind() != trace.SpanKindInternal {
		t.Errorf("span kind = %s, want internal", out[0].SpanKind())
	}
	return out[0]
}

func wantAttrs(t *testing.T, s sdktrace.ReadOnlySpan, want map[string]any) {
	t.Helper()
	got := spanAttrs(s)
	for k, v := range want {
		gv, ok := got[attribute.Key(k)]
		if !ok {
			t.Errorf("%s: attribute %s missing", s.Name(), k)
			continue
		}
		if gv.AsInterface() != v {
			t.Errorf("%s: attribute %s = %v, want %v", s.Name(), k, gv.AsInterface(), v)
		}
	}
}

func TestWrapClientDisabledReturnsSameClient(t *testing.T) {
	prev := enabled.Load()
	enabled.Store(false)
	t.Cleanup(func() { enabled.Store(prev) })

	c := k8sTestClient(t)
	if got := WrapClient(c, true); got != c {
		t.Fatalf("WrapClient returned %T, want the client unchanged", got)
	}
}

func TestWrapClientGetWithParent(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t, k8sTestPod("web", nil)), true)

	ctx, parent := tracer.Start(context.Background(), "server")
	var pod corev1.Pod
	if err := c.Get(ctx, client.ObjectKey{Namespace: "default", Name: "web"}, &pod); err != nil {
		t.Fatalf("Get: %v", err)
	}
	parent.End()

	s := onlySpan(t, rec, parent)
	if s.Name() != "k8s Get Pod" {
		t.Errorf("span name = %q, want %q", s.Name(), "k8s Get Pod")
	}
	wantAttrs(t, s, map[string]any{
		"k8s.namespace.name": "default",
		"kite.k8s.name":      "web",
		"kite.k8s.group":     "",
		"kite.k8s.version":   "v1",
		"kite.k8s.kind":      "Pod",
		"kite.k8s.source":    "cache",
	})
	if s.Status().Code != codes.Unset {
		t.Errorf("status = %v, want unset", s.Status())
	}
}

func TestWrapClientNoParentNoSpan(t *testing.T) {
	rec, _ := setupEnabled(t)
	c := WrapClient(k8sTestClient(t, k8sTestPod("web", nil)), true)

	var pod corev1.Pod
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "web"}, &pod); err != nil {
		t.Fatalf("Get: %v", err)
	}
	var pods corev1.PodList
	if err := c.List(context.Background(), &pods); err != nil {
		t.Fatalf("List: %v", err)
	}
	if err := c.Status().Update(context.Background(), &pod); err != nil {
		t.Fatalf("Status().Update: %v", err)
	}
	if n := len(rec.Started()); n != 0 {
		t.Fatalf("got %d spans without a parent, want 0", n)
	}
}

func TestWrapClientListItems(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t,
		k8sTestPod("a", map[string]string{"app": "web"}),
		k8sTestPod("b", map[string]string{"app": "web"}),
		k8sTestPod("c", map[string]string{"app": "db"}),
	), true)

	ctx, parent := tracer.Start(context.Background(), "server")
	var pods corev1.PodList
	if err := c.List(ctx, &pods, client.InNamespace("default"), client.MatchingLabels{"app": "web"}); err != nil {
		t.Fatalf("List: %v", err)
	}
	parent.End()

	s := onlySpan(t, rec, parent)
	if s.Name() != "k8s List Pod" {
		t.Errorf("span name = %q, want %q", s.Name(), "k8s List Pod")
	}
	wantAttrs(t, s, map[string]any{
		"k8s.namespace.name":      "default",
		"kite.k8s.kind":           "Pod",
		"kite.k8s.source":         "cache",
		"kite.k8s.items":          int64(2),
		"kite.k8s.label_selector": "app=web",
	})
}

func TestWrapClientUnstructuredReadsFromAPI(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t, k8sTestPod("a", nil)), true)

	ctx, parent := tracer.Start(context.Background(), "server")
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(schema.GroupVersionKind{Version: "v1", Kind: "PodList"})
	if err := c.List(ctx, list); err != nil {
		t.Fatalf("List: %v", err)
	}
	parent.End()

	s := onlySpan(t, rec, parent)
	if s.Name() != "k8s List Pod" {
		t.Errorf("span name = %q, want %q", s.Name(), "k8s List Pod")
	}
	wantAttrs(t, s, map[string]any{"kite.k8s.source": "api", "kite.k8s.items": int64(1)})
}

func TestWrapClientUncachedSourceIsAPI(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t, k8sTestPod("web", nil)), false)

	ctx, parent := tracer.Start(context.Background(), "server")
	var pod corev1.Pod
	if err := c.Get(ctx, client.ObjectKey{Namespace: "default", Name: "web"}, &pod); err != nil {
		t.Fatalf("Get: %v", err)
	}
	parent.End()

	wantAttrs(t, onlySpan(t, rec, parent), map[string]any{"kite.k8s.source": "api"})
}

func TestWrapClientGetNotFoundIsNotAnError(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t), true)

	ctx, parent := tracer.Start(context.Background(), "server")
	var pod corev1.Pod
	err := c.Get(ctx, client.ObjectKey{Namespace: "default", Name: "missing"}, &pod)
	parent.End()
	if !apierrors.IsNotFound(err) {
		t.Fatalf("Get err = %v, want NotFound returned to the caller", err)
	}

	s := onlySpan(t, rec, parent)
	if s.Status().Code != codes.Unset {
		t.Errorf("status = %v, want unset", s.Status())
	}
	if len(s.Events()) != 0 {
		t.Errorf("recorded %d events, want none", len(s.Events()))
	}
	wantAttrs(t, s, map[string]any{"kite.k8s.not_found": true})
}

func TestWrapClientWriteErrorStatus(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t, k8sTestPod("web", nil)), true)

	ctx, parent := tracer.Start(context.Background(), "server")
	err := c.Create(ctx, k8sTestPod("web", nil))
	parent.End()
	if !apierrors.IsAlreadyExists(err) {
		t.Fatalf("Create err = %v, want AlreadyExists", err)
	}

	s := onlySpan(t, rec, parent)
	if s.Name() != "k8s Create Pod" {
		t.Errorf("span name = %q, want %q", s.Name(), "k8s Create Pod")
	}
	if s.Status().Code != codes.Error {
		t.Errorf("status = %v, want error", s.Status())
	}
	wantAttrs(t, s, map[string]any{"kite.k8s.source": "api", "kite.k8s.name": "web"})
}

func TestWrapClientSubResources(t *testing.T) {
	rec, tracer := setupEnabled(t)
	c := WrapClient(k8sTestClient(t, k8sTestPod("web", nil)), true)

	ctx, parent := tracer.Start(context.Background(), "server")
	var pod corev1.Pod
	if err := c.Get(ctx, client.ObjectKey{Namespace: "default", Name: "web"}, &pod); err != nil {
		t.Fatalf("Get: %v", err)
	}
	pod.Status.Phase = corev1.PodRunning
	if err := c.Status().Update(ctx, &pod); err != nil {
		t.Fatalf("Status().Update: %v", err)
	}
	pod.Status.Phase = corev1.PodSucceeded
	if err := c.SubResource("status").Update(ctx, &pod); err != nil {
		t.Fatalf("SubResource(status).Update: %v", err)
	}
	parent.End()

	got := map[string]sdktrace.ReadOnlySpan{}
	for _, s := range rec.Ended() {
		got[s.Name()] = s
	}
	s, ok := got["k8s Update Pod/status"]
	if !ok {
		t.Fatalf("no k8s Update Pod/status span; got %v", keys(got))
	}
	if s.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Errorf("subresource span parent = %s, want %s", s.Parent().SpanID(), parent.SpanContext().SpanID())
	}
	wantAttrs(t, s, map[string]any{"kite.k8s.subresource": "status", "kite.k8s.source": "api", "kite.k8s.name": "web"})

	n := 0
	for _, s := range rec.Ended() {
		if s.Name() == "k8s Update Pod/status" {
			n++
		}
	}
	if n != 2 {
		t.Errorf("k8s Update Pod/status spans = %d, want 2 (Status() and SubResource(\"status\"))", n)
	}
}

func keys(m map[string]sdktrace.ReadOnlySpan) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

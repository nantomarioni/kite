package tracing

import (
	"context"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"
	"go.opentelemetry.io/otel/trace"
	"k8s.io/client-go/rest"
)

// StartDescribe starts an internal "kubectl describe <Kind>" span when ctx
// carries a valid span. It returns the context to derive the describer's
// config from (see ConfigWithParent) and an end func that records err and
// ends the span. Disabled / no parent: ctx unchanged and a no-op end.
func StartDescribe(ctx context.Context, kind, namespace, name string) (context.Context, func(error)) {
	if !k8sTraceable(ctx) {
		return ctx, func(error) {}
	}
	attrs := []attribute.KeyValue{attribute.String("kite.k8s.kind", kind)}
	if namespace != "" {
		attrs = append(attrs, semconv.K8SNamespaceName(namespace))
	}
	if name != "" {
		attrs = append(attrs, attribute.String("kite.k8s.name", name))
	}
	ctx, span := k8sStartSpan(ctx, "kubectl describe "+kind, attrs...)
	return ctx, func(err error) { k8sEndSpan(span, err) }
}

// ConfigWithParent returns a copy of cfg whose requests are re-parented under
// ctx's span when they carry no span of their own. kubectl's describers call
// the API with context.TODO(), so without this their requests would be
// invisible to the gated "kubernetes" transport installed by
// cluster_manager.go. The re-parenting RoundTripper is the outermost
// WrapTransport layer, so that inner transport sees the parent.
//
// client-go's TLS transport cache (transport/cache.go tlsConfigKey) does not
// key on WrapTransport, so the copy still shares the cluster's connection pool.
// Disabled tracing, or no valid span in ctx, returns cfg unchanged.
func ConfigWithParent(ctx context.Context, cfg *rest.Config) *rest.Config {
	if cfg == nil || !k8sTraceable(ctx) {
		return cfg
	}
	parent := trace.SpanFromContext(ctx)
	out := rest.CopyConfig(cfg)
	out.Wrap(func(rt http.RoundTripper) http.RoundTripper {
		return &describeParentTransport{base: rt, parent: parent}
	})
	return out
}

type describeParentTransport struct {
	base   http.RoundTripper
	parent trace.Span
}

func (t *describeParentTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !trace.SpanContextFromContext(req.Context()).IsValid() {
		req = req.WithContext(trace.ContextWithSpan(req.Context(), t.parent))
	}
	return t.base.RoundTrip(req)
}

// WrappedRoundTripper implements k8s.io/apimachinery/pkg/util/net.RoundTripperWrapper.
func (t *describeParentTransport) WrappedRoundTripper() http.RoundTripper {
	return t.base
}

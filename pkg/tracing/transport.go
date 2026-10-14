package tracing

import (
	"net/http"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Headers that mark a streaming-upgrade request at the point it passes through
// a rest.Config.WrapTransport wrapper. client-go's SPDY and WebSocket
// round trippers add Upgrade/Connection themselves, *below* the wrapper, so
// those alone are not enough:
//   - SPDY (exec/attach/port-forward): k8s.io/client-go/transport/spdy.Negotiate
//     sets X-Stream-Protocol-Version before client.Do; Upgrade is added later
//     in apimachinery's SpdyRoundTripper.RoundTrip.
//   - WebSocket (remotecommand/port-forward tunnelling):
//     k8s.io/client-go/transport/websocket.Negotiate sets Sec-Websocket-Protocol;
//     gorilla's dialer adds Upgrade itself.
//
// Upgrade / Connection: Upgrade still cover plain proxied WebSocket requests
// (pkg/kube/proxy.go forwards the browser's headers).
const (
	headerStreamProtocolVersion = "X-Stream-Protocol-Version"
	headerWebSocketProtocol     = "Sec-Websocket-Protocol"
)

// WrapTransport instruments outbound requests made by component (e.g.
// "kubernetes", "prometheus"). With tracing disabled it returns rt unchanged.
//
// A client span is only created when the request context already carries a
// valid span (i.e. it is part of an incoming, traced request): background
// informer list/watch calls must not become orphan root traces. Upgrade
// (exec/attach/port-forward/WebSocket) requests are never traced.
func WrapTransport(component string, rt http.RoundTripper) http.RoundTripper {
	if !Enabled() || rt == nil {
		return rt
	}
	return &gatedTransport{
		base: rt,
		traced: otelhttp.NewTransport(rt,
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				return component + " " + r.Method
			}),
			otelhttp.WithSpanOptions(trace.WithAttributes(attribute.String("peer.service", component))),
		),
	}
}

type gatedTransport struct {
	base   http.RoundTripper
	traced http.RoundTripper
}

func (t *gatedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if isUpgrade(req) || !trace.SpanContextFromContext(req.Context()).IsValid() {
		return t.base.RoundTrip(req)
	}
	return t.traced.RoundTrip(req)
}

// WrappedRoundTripper implements k8s.io/apimachinery/pkg/util/net.RoundTripperWrapper
// so client-go helpers (TLSClientConfig, DialerFor, CloseIdleConnectionsFor)
// can still see through the wrapper.
func (t *gatedTransport) WrappedRoundTripper() http.RoundTripper {
	return t.base
}

// CloseIdleConnections lets http.Client.CloseIdleConnections reach the base.
func (t *gatedTransport) CloseIdleConnections() {
	if c, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		c.CloseIdleConnections()
	}
}

func isUpgrade(req *http.Request) bool {
	h := req.Header
	if h.Get("Upgrade") != "" || h.Get(headerStreamProtocolVersion) != "" || h.Get(headerWebSocketProtocol) != "" {
		return true
	}
	for _, v := range h.Values("Connection") {
		for _, token := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

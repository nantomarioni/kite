package tracing

import (
	"context"
	"time"

	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"
	"go.opentelemetry.io/otel/trace"
)

// WrapPrometheusAPI instruments the Prometheus HTTP API methods kite calls
// (QueryRange, Query) with internal "prometheus <operation>" spans, created
// only when the call's context already carries a valid span. Other methods
// pass straight through. Disabled tracing returns api as is.
func WrapPrometheusAPI(api v1.API) v1.API {
	if !Enabled() || api == nil {
		return api
	}
	return &promTracedAPI{API: api}
}

type promTracedAPI struct {
	v1.API
}

// QueryRange implements v1.API.
func (p *promTracedAPI) QueryRange(ctx context.Context, query string, r v1.Range, opts ...v1.Option) (model.Value, v1.Warnings, error) {
	if !k8sTraceable(ctx) {
		return p.API.QueryRange(ctx, query, r, opts...)
	}
	ctx, span := promStart(ctx, "query_range", query,
		attribute.String("kite.prometheus.range.start", r.Start.UTC().Format(time.RFC3339)),
		attribute.String("kite.prometheus.range.end", r.End.UTC().Format(time.RFC3339)),
		attribute.String("kite.prometheus.range.step", r.Step.String()),
	)
	val, warnings, err := p.API.QueryRange(ctx, query, r, opts...)
	promEnd(span, val, warnings, err)
	return val, warnings, err
}

// Query implements v1.API.
func (p *promTracedAPI) Query(ctx context.Context, query string, ts time.Time, opts ...v1.Option) (model.Value, v1.Warnings, error) {
	if !k8sTraceable(ctx) {
		return p.API.Query(ctx, query, ts, opts...)
	}
	var attrs []attribute.KeyValue
	if !ts.IsZero() {
		attrs = append(attrs, attribute.String("kite.prometheus.time", ts.UTC().Format(time.RFC3339)))
	}
	ctx, span := promStart(ctx, "query", query, attrs...)
	val, warnings, err := p.API.Query(ctx, query, ts, opts...)
	promEnd(span, val, warnings, err)
	return val, warnings, err
}

func promStart(ctx context.Context, op, query string, extra ...attribute.KeyValue) (context.Context, trace.Span) {
	attrs := append([]attribute.KeyValue{
		semconv.DBSystemNameKey.String("prometheus"),
		semconv.DBOperationName(op),
		semconv.DBQueryText(query),
	}, extra...)
	return k8sStartSpan(ctx, "prometheus "+op, attrs...)
}

func promEnd(span trace.Span, val model.Value, warnings v1.Warnings, err error) {
	span.SetAttributes(attribute.Int("kite.prometheus.warnings", len(warnings)))
	if err == nil && val != nil {
		series, samples := promCount(val)
		span.SetAttributes(
			attribute.String("kite.prometheus.result_type", val.Type().String()),
			attribute.Int("kite.prometheus.series", series),
			attribute.Int("kite.prometheus.samples", samples),
		)
	}
	k8sEndSpan(span, err)
}

// promCount returns the number of series and samples (float + histogram) in a
// query result.
func promCount(val model.Value) (series, samples int) {
	switch v := val.(type) {
	case model.Matrix:
		for _, s := range v {
			samples += len(s.Values) + len(s.Histograms)
		}
		return len(v), samples
	case model.Vector:
		return len(v), len(v)
	case *model.Scalar, *model.String:
		return 1, 1
	default:
		return 0, 0
	}
}

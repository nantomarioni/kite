// Package tracing wires OpenTelemetry distributed tracing (fork addition).
//
// Configuration is the standard OTEL_* environment surface, read by the SDK
// itself (deliberately not routed through pkg/common). Tracing is enabled only
// when an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or
// OTEL_EXPORTER_OTLP_ENDPOINT) and OTEL_SDK_DISABLED is not "true"; otherwise
// nothing is installed and kite behaves exactly as without tracing.
package tracing

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync/atomic"

	"github.com/zxh326/kite/pkg/version"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"
	"k8s.io/klog/v2"
)

// DefaultServiceName is the service.name used unless OTEL_SERVICE_NAME or
// OTEL_RESOURCE_ATTRIBUTES override it.
const DefaultServiceName = "kite"

var enabled atomic.Bool

// Enabled reports whether Init installed a tracer provider.
func Enabled() bool {
	return enabled.Load()
}

// configured reports whether the environment asks for tracing.
func configured() bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		return false
	}
	return strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) != "" ||
		strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) != ""
}

// Init sets up the global tracer provider and propagator from the OTEL_*
// environment. When tracing is not configured it installs nothing and returns
// a no-op shutdown. The returned shutdown flushes and stops the provider.
func Init(ctx context.Context) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	if !configured() {
		return noop, nil
	}

	// No endpoint options: the exporter reads OTEL_EXPORTER_OTLP_[TRACES_]*
	// itself (a signal-specific URL is used as-is, http:// means insecure).
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return noop, err
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(DefaultServiceName),
			semconv.ServiceVersion(version.Version),
		),
		resource.WithTelemetrySDK(),
		resource.WithFromEnv(), // last, so OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES win
	)
	if err != nil {
		// Partial resources are still usable; report and carry on.
		klog.Warningf("otel: resource detection: %v", err)
	}

	// No sampler option: the SDK default is ParentBased(AlwaysOn) and
	// OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG keep working. The batcher
	// honours the OTEL_BSP_* variables.
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		klog.Warningf("otel: %v", err)
	}))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	enabled.Store(true)

	klog.Infof("OpenTelemetry tracing enabled (OTLP/HTTP exporter, endpoint: %s)", endpointForLog())

	return func(ctx context.Context) error {
		enabled.Store(false)
		return tp.Shutdown(ctx)
	}, nil
}

// endpointForLog returns the configured endpoint with any userinfo password
// redacted.
func endpointForLog() string {
	v := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))
	if v == "" {
		v = strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	}
	if u, err := url.Parse(v); err == nil {
		return u.Redacted()
	}
	return "(unparseable)"
}

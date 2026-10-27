package tracing

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zxh326/kite/pkg/common"
)

func TestShouldTraceFiltersAfterStrippingBase(t *testing.T) {
	prev := common.Base
	common.Base = "/kite"
	t.Cleanup(func() { common.Base = prev })

	cases := []struct {
		method, path string
		want         bool
	}{
		{http.MethodGet, "/kite/healthz", false},
		{http.MethodGet, "/kite/metrics", false},
		{http.MethodGet, "/kite/favicon.ico", false},
		{http.MethodGet, "/kite/assets/index-abc.js", false},
		{http.MethodOptions, "/kite/api/v1/pods", false},
		{http.MethodGet, "/kite/api/v1/pods", true},
		{http.MethodGet, "/kite/", true},
		{http.MethodGet, "/kite/healthz/extra", true},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		if got := shouldTrace(req); got != tc.want {
			t.Errorf("shouldTrace(%s %s) = %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}
}

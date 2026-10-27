package tracing

import (
	"context"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const gormSentinel = "s3cr3t-sentinel-kubeconfig-token"

type gormTestSecret struct {
	ID    uint   `gorm:"primarykey"`
	Name  string `gorm:"uniqueIndex"`
	Token string
}

type gormTestParent struct {
	ID       uint `gorm:"primarykey"`
	Name     string
	Children []gormTestChild `gorm:"foreignKey:ParentID"`
}

type gormTestChild struct {
	ID       uint `gorm:"primarykey"`
	ParentID uint
	Secret   string
}

// gormOpenTestDB opens a private in-memory sqlite DB with the test schema
// migrated (before instrumentation, so migration produces no spans).
func gormOpenTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1) // one connection = one in-memory database
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&gormTestSecret{}, &gormTestParent{}, &gormTestChild{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func gormSetupInstrumented(t *testing.T) (*gorm.DB, *tracetest.SpanRecorder, trace.Tracer) {
	t.Helper()
	rec, tracer := setupEnabled(t)
	db := gormOpenTestDB(t)
	if err := InstrumentDB(db); err != nil {
		t.Fatalf("InstrumentDB: %v", err)
	}
	return db, rec, tracer
}

func gormClientSpans(rec *tracetest.SpanRecorder) []sdktrace.ReadOnlySpan {
	var out []sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.SpanKind() == trace.SpanKindClient {
			out = append(out, s)
		}
	}
	return out
}

func gormAttrs(s sdktrace.ReadOnlySpan) map[attribute.Key]attribute.Value {
	m := map[attribute.Key]attribute.Value{}
	for _, kv := range s.Attributes() {
		m[kv.Key] = kv.Value
	}
	return m
}

func gormSpanByName(t *testing.T, spans []sdktrace.ReadOnlySpan, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, s := range spans {
		if s.Name() == name {
			return s
		}
	}
	names := make([]string, 0, len(spans))
	for _, s := range spans {
		names = append(names, s.Name())
	}
	t.Fatalf("no span %q among %v", name, names)
	return nil
}

func TestInstrumentDBWithParentSpan(t *testing.T) {
	db, rec, tracer := gormSetupInstrumented(t)

	ctx, parent := tracer.Start(context.Background(), "server")
	row := gormTestSecret{Name: "alpha", Token: "plain"}
	if err := db.WithContext(ctx).Create(&row).Error; err != nil {
		t.Fatalf("create: %v", err)
	}
	var got gormTestSecret
	if err := db.WithContext(ctx).Where("name = ?", "alpha").First(&got).Error; err != nil {
		t.Fatalf("first: %v", err)
	}
	parent.End()

	spans := gormClientSpans(rec)
	if len(spans) != 2 {
		t.Fatalf("client spans = %d, want 2", len(spans))
	}
	for name, op := range map[string]string{
		"INSERT gorm_test_secrets": "INSERT",
		"SELECT gorm_test_secrets": "SELECT",
	} {
		s := gormSpanByName(t, spans, name)
		if s.Parent().SpanID() != parent.SpanContext().SpanID() {
			t.Errorf("%s: parent = %s, want %s", name, s.Parent().SpanID(), parent.SpanContext().SpanID())
		}
		a := gormAttrs(s)
		if v := a["db.system.name"].AsString(); v != "sqlite" {
			t.Errorf("%s: db.system.name = %q, want sqlite", name, v)
		}
		if v := a["db.operation.name"].AsString(); v != op {
			t.Errorf("%s: db.operation.name = %q, want %q", name, v, op)
		}
		if v := a["db.collection.name"].AsString(); v != "gorm_test_secrets" {
			t.Errorf("%s: db.collection.name = %q", name, v)
		}
		q := a["db.query.text"].AsString()
		if !strings.HasPrefix(q, op) || !strings.Contains(q, "?") {
			t.Errorf("%s: db.query.text = %q, want %s SQL with placeholders", name, q, op)
		}
		if strings.Contains(q, "alpha") || strings.Contains(q, "plain") {
			t.Errorf("%s: db.query.text leaks a bound value: %q", name, q)
		}
		if v := a[gormRowsAffectedKey].AsInt64(); v != 1 {
			t.Errorf("%s: rows affected = %d, want 1", name, v)
		}
		if s.Status().Code != codes.Unset {
			t.Errorf("%s: status = %v, want unset", name, s.Status())
		}
	}
}

func TestInstrumentDBNeverRecordsBoundValues(t *testing.T) {
	db, rec, tracer := gormSetupInstrumented(t)

	ctx, parent := tracer.Start(context.Background(), "server")
	steps := []func() error{
		func() error {
			return db.WithContext(ctx).Create(&gormTestSecret{Name: "beta", Token: gormSentinel}).Error
		},
		func() error {
			var out []gormTestSecret
			return db.WithContext(ctx).Where("token = ?", gormSentinel).Find(&out).Error
		},
		func() error {
			return db.WithContext(ctx).Model(&gormTestSecret{}).Where("name = ?", "beta").
				Update("token", gormSentinel+"-updated").Error
		},
		func() error {
			return db.WithContext(ctx).Exec("UPDATE gorm_test_secrets SET token = ? WHERE token = ?", gormSentinel, gormSentinel).Error
		},
		func() error {
			return db.WithContext(ctx).Create(&gormTestParent{Name: "p", Children: []gormTestChild{{Secret: gormSentinel}}}).Error
		},
	}
	for i, step := range steps {
		if err := step(); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}
	// A failing statement: its error must not carry the value either.
	if err := db.WithContext(ctx).Create(&gormTestSecret{Name: "beta", Token: gormSentinel}).Error; err == nil {
		t.Fatal("duplicate insert succeeded, want a unique-constraint error")
	}
	parent.End()

	spans := gormClientSpans(rec)
	if len(spans) < len(steps)+1 {
		t.Fatalf("client spans = %d, want at least %d", len(spans), len(steps)+1)
	}
	var sawError bool
	for _, s := range spans {
		check := func(where, v string) {
			if strings.Contains(v, gormSentinel) {
				t.Errorf("span %q: secret leaked in %s: %q", s.Name(), where, v)
			}
		}
		check("name", s.Name())
		check("status", s.Status().Description)
		for _, kv := range s.Attributes() {
			check(string(kv.Key), kv.Value.Emit())
		}
		for _, ev := range s.Events() {
			check("event "+ev.Name, ev.Name)
			for _, kv := range ev.Attributes {
				check("event "+string(kv.Key), kv.Value.Emit())
			}
		}
		if s.Status().Code == codes.Error {
			sawError = true
		}
	}
	if !sawError {
		t.Error("the failing insert produced no error span")
	}
}

func TestInstrumentDBNoParentSpan(t *testing.T) {
	db, rec, _ := gormSetupInstrumented(t)

	ctx := context.Background()
	if err := db.WithContext(ctx).Create(&gormTestSecret{Name: "gamma"}).Error; err != nil {
		t.Fatal(err)
	}
	var out []gormTestSecret
	if err := db.WithContext(ctx).Find(&out).Error; err != nil {
		t.Fatal(err)
	}
	// No WithContext at all: gorm's default background context.
	if err := db.Where("name = ?", "gamma").Delete(&gormTestSecret{}).Error; err != nil {
		t.Fatal(err)
	}
	if n := len(rec.Started()) + len(rec.Ended()); n != 0 {
		t.Fatalf("got %d spans without a parent span, want 0", n)
	}
}

func TestInstrumentDBRecordNotFoundIsNotAnError(t *testing.T) {
	db, rec, tracer := gormSetupInstrumented(t)

	ctx, parent := tracer.Start(context.Background(), "server")
	var out gormTestSecret
	err := db.WithContext(ctx).Where("name = ?", "missing").First(&out).Error
	if err == nil {
		t.Fatal("First on a missing row returned no error")
	}
	// A real error for contrast.
	_ = db.WithContext(ctx).Table("no_such_table").Find(&[]gormTestSecret{}).Error
	parent.End()

	miss := gormSpanByName(t, gormClientSpans(rec), "SELECT gorm_test_secrets")
	if miss.Status().Code != codes.Unset || len(miss.Events()) != 0 {
		t.Errorf("record-not-found span: status %v, %d events; want unset, none", miss.Status(), len(miss.Events()))
	}
	bad := gormSpanByName(t, gormClientSpans(rec), "SELECT no_such_table")
	if bad.Status().Code != codes.Error {
		t.Errorf("missing-table span status = %v, want error", bad.Status())
	}
}

func TestInstrumentDBNestsPreloadAndRestoresContext(t *testing.T) {
	db, rec, tracer := gormSetupInstrumented(t)
	if err := db.Create(&gormTestParent{Name: "p", Children: []gormTestChild{{Secret: "x"}}}).Error; err != nil {
		t.Fatal(err)
	}

	ctx, parent := tracer.Start(context.Background(), "server")
	tx := db.WithContext(ctx).Preload("Children")
	var parents []gormTestParent
	res := tx.Find(&parents)
	if res.Error != nil || len(parents) != 1 || len(parents[0].Children) != 1 {
		t.Fatalf("preload: err=%v parents=%+v", res.Error, parents)
	}
	if got := res.Statement.Context; got != ctx {
		t.Error("statement context was not restored after the span ended")
	}
	parent.End()

	spans := gormClientSpans(rec)
	outer := gormSpanByName(t, spans, "SELECT gorm_test_parents")
	inner := gormSpanByName(t, spans, "SELECT gorm_test_children")
	if outer.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Errorf("outer parent = %s, want the server span", outer.Parent().SpanID())
	}
	if inner.Parent().SpanID() != outer.SpanContext().SpanID() {
		t.Errorf("preload span parent = %s, want the outer SELECT %s", inner.Parent().SpanID(), outer.SpanContext().SpanID())
	}
}

func TestInstrumentDBDisabledRegistersNothing(t *testing.T) {
	prev := enabled.Load()
	enabled.Store(false)
	t.Cleanup(func() { enabled.Store(prev) })

	db := gormOpenTestDB(t)
	if err := InstrumentDB(db); err != nil {
		t.Fatalf("InstrumentDB: %v", err)
	}
	if _, ok := db.Plugins[gormPluginName]; ok {
		t.Error("plugin registered while tracing is disabled")
	}
	if db.Callback().Query().Get(gormPluginName+":before_query") != nil {
		t.Error("query callback registered while tracing is disabled")
	}
}

func TestGormSystemName(t *testing.T) {
	db := &gorm.DB{Config: &gorm.Config{}}
	for in, want := range map[string]string{"sqlite": "sqlite", "mysql": "mysql", "postgres": "postgresql"} {
		if got := gormSystemName(in, db); got != want {
			t.Errorf("gormSystemName(%q) = %q, want %q", in, got, want)
		}
	}
}

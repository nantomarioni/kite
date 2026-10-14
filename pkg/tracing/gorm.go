package tracing

import (
	"context"
	"errors"
	"strings"

	"github.com/zxh326/kite/pkg/common"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"
	"go.opentelemetry.io/otel/trace"
	"gorm.io/gorm"
)

const (
	gormPluginName = "kite:otel"
	gormTracerName = "github.com/zxh326/kite/pkg/tracing/gorm"
	// gormStateKey stores the in-flight span on the statement between the
	// before and after callbacks.
	gormStateKey = "kite:otel:state"
	// gormRowsAffectedKey: there is no stable semconv attribute for affected
	// rows; same key as gorm.io/plugin/opentelemetry.
	gormRowsAffectedKey = attribute.Key("db.rows_affected")
)

// InstrumentDB registers GORM callbacks that create a client span per
// statement. With tracing disabled it registers nothing.
//
// A span is only created when the statement context already carries a valid
// span (an incoming, traced request): startup seeding and the background
// RBAC/cluster syncs must not become orphan root traces. Only the SQL with its
// placeholders is recorded, never the bound values: the tables hold password
// hashes, API keys, kubeconfigs and OAuth client secrets.
func InstrumentDB(db *gorm.DB) error {
	if !Enabled() || db == nil {
		return nil
	}
	return db.Use(&gormPlugin{system: gormSystemName(common.DBType, db)})
}

// gormSystemName maps kite's DB_TYPE to the db.system.name semconv value.
func gormSystemName(dbType string, db *gorm.DB) string {
	switch dbType {
	case "sqlite":
		return semconv.DBSystemNameSQLite.Value.AsString()
	case "mysql":
		return semconv.DBSystemNameMySQL.Value.AsString()
	case "postgres":
		return semconv.DBSystemNamePostgreSQL.Value.AsString()
	}
	if d := db.Dialector; d != nil {
		return d.Name()
	}
	return dbType
}

type gormPlugin struct {
	system string
}

// gormState is what the before callback hands to the after callback.
type gormState struct {
	// stmt guards against a state copied into a cloned (nested) statement's
	// Settings: only the statement that started the span may end it.
	stmt      *gorm.Statement
	span      trace.Span
	parentCtx context.Context
}

func (p *gormPlugin) Name() string { return gormPluginName }

func (p *gormPlugin) Initialize(db *gorm.DB) error {
	cb := db.Callback()
	name := func(phase, kind string) string { return gormPluginName + ":" + phase + "_" + kind }
	return errors.Join(
		cb.Create().Before("*").Register(name("before", "create"), p.before("INSERT")),
		cb.Create().After("*").Register(name("after", "create"), p.after("INSERT")),
		cb.Query().Before("*").Register(name("before", "query"), p.before("SELECT")),
		cb.Query().After("*").Register(name("after", "query"), p.after("SELECT")),
		cb.Update().Before("*").Register(name("before", "update"), p.before("UPDATE")),
		cb.Update().After("*").Register(name("after", "update"), p.after("UPDATE")),
		cb.Delete().Before("*").Register(name("before", "delete"), p.before("DELETE")),
		cb.Delete().After("*").Register(name("after", "delete"), p.after("DELETE")),
		cb.Row().Before("*").Register(name("before", "row"), p.before("SELECT")),
		cb.Row().After("*").Register(name("after", "row"), p.after("SELECT")),
		cb.Raw().Before("*").Register(name("before", "raw"), p.before("RAW")),
		cb.Raw().After("*").Register(name("after", "raw"), p.after("RAW")),
	)
}

// before starts the span, but only under an existing (request) span. The
// statement context is swapped for the span context so nested statements
// (preloads, associations) become children; after restores it.
func (p *gormPlugin) before(operation string) func(*gorm.DB) {
	return func(db *gorm.DB) {
		stmt := db.Statement
		if stmt == nil || stmt.Context == nil || !trace.SpanContextFromContext(stmt.Context).IsValid() {
			return
		}
		ctx, span := otel.Tracer(gormTracerName).Start(stmt.Context, gormSpanName(operation, stmt.Table),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(semconv.DBSystemNameKey.String(p.system)),
		)
		stmt.Settings.Store(gormStateKey, &gormState{stmt: stmt, span: span, parentCtx: stmt.Context})
		stmt.Context = ctx
	}
}

func (p *gormPlugin) after(fallbackOperation string) func(*gorm.DB) {
	return func(db *gorm.DB) {
		stmt := db.Statement
		if stmt == nil {
			return
		}
		v, ok := stmt.Settings.LoadAndDelete(gormStateKey)
		if !ok {
			return
		}
		state, ok := v.(*gormState)
		if !ok || state.stmt != stmt {
			return
		}
		stmt.Context = state.parentCtx
		span := state.span
		defer span.End()

		// Placeholder SQL only: the bound values live in stmt.Vars and are
		// deliberately never read here.
		query := stmt.SQL.String()
		operation := gormOperation(query, fallbackOperation)
		span.SetName(gormSpanName(operation, stmt.Table))
		attrs := []attribute.KeyValue{
			semconv.DBOperationName(operation),
			gormRowsAffectedKey.Int64(db.RowsAffected),
		}
		if stmt.Table != "" {
			attrs = append(attrs, semconv.DBCollectionName(stmt.Table))
		}
		if query != "" {
			attrs = append(attrs, semconv.DBQueryText(query))
		}
		span.SetAttributes(attrs...)

		if err := db.Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
	}
}

// gormOperation returns the SQL verb (first keyword) of query, or fallback
// when no SQL was built.
func gormOperation(query, fallback string) string {
	fields := strings.Fields(query)
	if len(fields) == 0 {
		return fallback
	}
	return strings.ToUpper(fields[0])
}

func gormSpanName(operation, table string) string {
	if table == "" {
		return operation
	}
	return operation + " " + table
}

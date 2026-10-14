FROM node:20-alpine AS frontend-builder

WORKDIR /app/ui

COPY ui/package.json ui/pnpm-lock.yaml ./

# Pinned to the major CI uses (ci.yml: pnpm 10); unpinned `pnpm` now resolves to
# a major that fails on ignored dependency build scripts (ERR_PNPM_IGNORED_BUILDS).
RUN npm install -g pnpm@10.34.6 && \
    pnpm install --frozen-lockfile

COPY ui/ ./
RUN pnpm run build

FROM golang:1.25-alpine AS backend-builder

WORKDIR /app

COPY go.mod ./
COPY go.sum ./

RUN go mod download

COPY . .

COPY --from=frontend-builder /app/static ./static
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o kite .

FROM gcr.io/distroless/static

WORKDIR /app

COPY --from=backend-builder /app/kite .

EXPOSE 8080

CMD ["./kite"]

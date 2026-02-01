package common

import (
	"os"
	"strings"
	"time"

	"k8s.io/klog/v2"
)

const (
	JWTExpirationSeconds = 24 * 60 * 60 // 24 hours

	NodeTerminalPodName = "kite-node-terminal-agent"

	KubectlAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

	// db connection max idle time
	DBMaxIdleTime  = 10 * time.Minute
	DBMaxOpenConns = 100
	DBMaxIdleConns = 10
)

var (
	Port            = "8080"
	JwtSecret       = "kite-default-jwt-secret-key-change-in-production"
	EnableAnalytics = false
	Host            = ""
	Base            = ""

	NodeTerminalImage = "busybox:latest"
	DBType            = "sqlite"
	DBDSN             = "dev.db"

	KiteEncryptKey = "kite-default-encryption-key-change-in-production"

	AnonymousUserEnabled = false

	CookieExpirationSeconds = 2 * JWTExpirationSeconds // double jwt

	DisableGZIP         = true
	DisableVersionCheck = false

	APIKeyProvider    = "api_key"
	AuthProxyProvider = "authproxy"

	// Auth Proxy configuration
	AuthProxyEnabled        = false
	AuthProxyHeaderUsername = "X-Authentik-Username"
	AuthProxyHeaderEmail    = "X-Authentik-Email"
	AuthProxyHeaderName     = "X-Authentik-Name"
	AuthProxyHeaderUID      = "X-Authentik-Uid"
	AuthProxyHeaderGroups   = "X-Authentik-Groups"
	AuthProxyDefaultRole    = ""
)

func LoadEnvs() {
	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		JwtSecret = secret
	}

	if port := os.Getenv("PORT"); port != "" {
		Port = port
	}

	if analytics := os.Getenv("ENABLE_ANALYTICS"); analytics == "true" {
		EnableAnalytics = true
	}

	if nodeTerminalImage := os.Getenv("NODE_TERMINAL_IMAGE"); nodeTerminalImage != "" {
		NodeTerminalImage = nodeTerminalImage
	}

	if dbDSN := os.Getenv("DB_DSN"); dbDSN != "" {
		DBDSN = dbDSN
	}

	if dbType := os.Getenv("DB_TYPE"); dbType != "" {
		if dbType != "sqlite" && dbType != "mysql" && dbType != "postgres" {
			klog.Fatalf("Invalid DB_TYPE: %s, must be one of sqlite, mysql, postgres", dbType)
		}
		DBType = dbType
	}

	if key := os.Getenv("KITE_ENCRYPT_KEY"); key != "" {
		KiteEncryptKey = key
	} else {
		klog.Warningf("KITE_ENCRYPT_KEY is not set, using default key, this is not secure for production!")
	}

	if v := os.Getenv("ANONYMOUS_USER_ENABLED"); v == "true" {
		AnonymousUserEnabled = true
		klog.Warningf("Anonymous user is enabled, this is not secure for production!")
	}
	if v := os.Getenv("HOST"); v != "" {
		Host = v
	}
	if v := os.Getenv("DISABLE_GZIP"); v != "" {
		DisableGZIP = v == "true"
	}

	if v := os.Getenv("DISABLE_VERSION_CHECK"); v == "true" {
		DisableVersionCheck = true
	}

	if v := os.Getenv("KITE_BASE"); v != "" {
		if v[0] != '/' {
			v = "/" + v
		}
		Base = strings.TrimRight(v, "/")
		klog.Infof("Using base path: %s", Base)
	}

	// Auth Proxy configuration
	if v := os.Getenv("AUTH_PROXY_ENABLED"); v == "true" {
		AuthProxyEnabled = true
		klog.Infof("Auth proxy mode enabled")
	}
	if v := os.Getenv("AUTH_PROXY_HEADER_USERNAME"); v != "" {
		AuthProxyHeaderUsername = v
	}
	if v := os.Getenv("AUTH_PROXY_HEADER_EMAIL"); v != "" {
		AuthProxyHeaderEmail = v
	}
	if v := os.Getenv("AUTH_PROXY_HEADER_NAME"); v != "" {
		AuthProxyHeaderName = v
	}
	if v := os.Getenv("AUTH_PROXY_HEADER_UID"); v != "" {
		AuthProxyHeaderUID = v
	}
	if v := os.Getenv("AUTH_PROXY_HEADER_GROUPS"); v != "" {
		AuthProxyHeaderGroups = v
	}
	if v := os.Getenv("AUTH_PROXY_DEFAULT_ROLE"); v != "" {
		AuthProxyDefaultRole = v
	}
}

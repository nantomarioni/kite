package auth

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"k8s.io/klog/v2"
)

func (h *AuthHandler) RequireAPIKeyAuth(c *gin.Context, token string) {
	keyPart := strings.SplitN(token, "-", 2)
	if len(keyPart) < 2 {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	id := keyPart[0]
	key := keyPart[1]
	dbID, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	apikey, err := model.GetUserByIDCached(dbID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	if !apikey.Enabled || apikey.Provider != common.APIKeyProvider || key == "" || string(apikey.APIKey) == "" || key != string(apikey.APIKey) {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid API key",
		})
		c.Abort()
		return
	}
	_ = model.LoginUser(apikey)
	apikey.Roles = rbac.GetUserRoles(*apikey)
	c.Set("user", *apikey)
}

func (h *AuthHandler) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		if common.AnonymousUserEnabled {
			u := model.GetAnonymousUser()
			if u == nil {
				c.Set("user", model.AnonymousUser)
			} else {
				u.Roles = model.AnonymousUser.Roles
				c.Set("user", *u)
			}
			c.Next()
			return
		}

		// Auth Proxy authentication
		if common.AuthProxyEnabled {
			user, err := h.handleAuthProxyLogin(c)
			if err == nil && user != nil {
				user.Roles = rbac.GetUserRoles(*user)
				c.Set("user", *user)
				c.Next()
				return
			}
			// If auth proxy is enabled but headers are missing, this is an error
			// because we expect all requests to come through the proxy
			if err != nil {
				klog.V(1).Infof("Auth proxy login failed: %v", err)
			}
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Auth proxy authentication required",
			})
			c.Abort()
			return
		}
		authHeader := c.GetHeader("Authorization")
		if authHeader != "" {
			if after, ok := strings.CutPrefix(authHeader, "kite"); ok {
				h.RequireAPIKeyAuth(c, after)
				return
			}
		}
		tokenString, _ := c.Cookie("auth_token")
		if tokenString == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid or expired token",
			})
			c.Abort()
			return
		}

		claims, err := h.manager.ValidateJWT(tokenString)
		if err != nil {
			refreshedToken, refreshErr := h.manager.RefreshJWT(c, tokenString)
			if refreshErr != nil {
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "Invalid or expired token",
				})
				setCookieSecure(c, "auth_token", "", -1)
				c.Abort()
				return
			}
			setCookieSecure(c, "auth_token", refreshedToken, common.CookieExpirationSeconds)
			claims, err = h.manager.ValidateJWT(refreshedToken)
			if err != nil {
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "Failed to validate refreshed token",
				})
				setCookieSecure(c, "auth_token", "", -1)
				c.Abort()
				return
			}
		}
		user, err := model.GetUserByIDCached(uint64(claims.UserID))
		if err != nil || !user.Enabled {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "user not found",
			})
			setCookieSecure(c, "auth_token", "", -1)
			c.Abort()
			return
		}
		user.Roles = rbac.GetUserRoles(*user)
		c.Set("user", *user)
		c.Next()
	}
}

// handleAuthProxyLogin handles authentication via reverse proxy headers.
// It extracts user info from trusted headers and creates/updates the user.
func (h *AuthHandler) handleAuthProxyLogin(c *gin.Context) (*model.User, error) {
	uid := c.GetHeader(common.AuthProxyHeaderUID)
	if uid == "" {
		return nil, fmt.Errorf("missing required header: %s", common.AuthProxyHeaderUID)
	}

	username := c.GetHeader(common.AuthProxyHeaderUsername)
	if username == "" {
		username = uid // Fall back to UID if username not provided
	}

	name := c.GetHeader(common.AuthProxyHeaderName)
	email := c.GetHeader(common.AuthProxyHeaderEmail)

	// Parse groups from comma-separated header
	groupsHeader := c.GetHeader(common.AuthProxyHeaderGroups)
	var groups []string
	if groupsHeader != "" {
		for _, g := range strings.Split(groupsHeader, "|") {
			g = strings.TrimSpace(g)
			if g != "" {
				groups = append(groups, g)
			}
		}
	}

	klog.V(1).Infof("Auth proxy login: uid=%s, username=%s, name=%s, groups=%v",
		uid, username, name, groups)

	user, err := model.FindOrCreateAuthProxyUser(uid, username, name, email, groups)
	if err != nil {
		return nil, fmt.Errorf("failed to find/create auth proxy user: %w", err)
	}

	if !user.Enabled {
		return nil, fmt.Errorf("user %s is disabled", user.Key())
	}

	return user, nil
}

func (h *AuthHandler) RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, exists := c.Get("user")
		if !exists {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Not authenticated",
			})
			c.Abort()
			return
		}

		u := user.(model.User)
		if !rbac.UserHasRole(u, model.DefaultAdminRole.Name) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Admin role required",
			})
			c.Abort()
			return
		}

		c.Next()
	}
}

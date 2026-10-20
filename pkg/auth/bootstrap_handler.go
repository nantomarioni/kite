package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/version"
	"k8s.io/klog/v2"
)

type bootstrapSetupState struct {
	Initialized bool `json:"initialized"`
	Step        int  `json:"step"`
}

type bootstrapAuthOptions struct {
	Providers           []string `json:"providers"`
	CredentialProviders []string `json:"credentialProviders"`
	OAuthProviders      []string `json:"oauthProviders"`
	LoginPrompt         string   `json:"loginPrompt"`
	MFAEnabled          bool     `json:"mfaEnabled"`
	PasskeyLoginEnabled bool     `json:"passkeyLoginEnabled"`
}

type bootstrapCapabilities struct {
	AIEnabled      bool `json:"aiEnabled"`
	KubectlEnabled bool `json:"kubectlEnabled"`
}

type bootstrapResponse struct {
	KiteVersion                string                `json:"kiteVersion"`
	Setup                      bootstrapSetupState   `json:"setup"`
	Auth                       bootstrapAuthOptions  `json:"auth"`
	Capabilities               bootstrapCapabilities `json:"capabilities"`
	User                       *model.User           `json:"user"`
	HasGlobalSidebarPreference bool                  `json:"hasGlobalSidebarPreference"`
	GlobalSidebarPreference    string                `json:"globalSidebarPreference"`
}

func (h *AuthHandler) Bootstrap(c *gin.Context) {
	setting, err := model.GetGeneralSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load general setting"})
		return
	}

	setup := currentBootstrapSetup(c.Request.Context())
	var user *model.User
	if setup.Step == 0 && !setup.Initialized {
		c.SetCookie("auth_token", "", -1, "/", "", false, true)
	} else {
		user = h.bootstrapUser(c, setting)
	}

	globalSidebarPreference := strings.TrimSpace(setting.GlobalSidebarPreference)
	if user == nil {
		globalSidebarPreference = ""
	}

	c.JSON(http.StatusOK, bootstrapResponse{
		KiteVersion: version.Version,
		Setup:       setup,
		Auth:        h.bootstrapAuth(c.Request.Context(), setting),
		Capabilities: bootstrapCapabilities{
			AIEnabled:      setting.AIAgentEnabled && strings.TrimSpace(string(setting.AIAPIKey)) != "",
			KubectlEnabled: setting.KubectlEnabled,
		},
		User:                       user,
		HasGlobalSidebarPreference: globalSidebarPreference != "",
		GlobalSidebarPreference:    globalSidebarPreference,
	})
}

func currentBootstrapSetup(ctx context.Context) bootstrapSetupState {
	step := 0
	uc, _ := model.CountUsers(ctx)
	if uc == 0 && !common.AnonymousUserEnabled {
		return bootstrapSetupState{Initialized: false, Step: step}
	}
	if uc > 0 || common.AnonymousUserEnabled {
		step++
	}

	if common.IsSectionManaged("clusters") {
		step++
	} else {
		cc, _ := model.CountClusters(ctx)
		if cc > 0 {
			step++
		}
	}

	return bootstrapSetupState{Initialized: step == 2, Step: step}
}

func (h *AuthHandler) bootstrapAuth(ctx context.Context, setting *model.GeneralSetting) bootstrapAuthOptions {
	var credentialProviders []string
	loginPrompt := ""

	if setting == nil || !setting.PasswordLoginDisabled {
		credentialProviders = append(credentialProviders, model.AuthProviderPassword)
	}
	if setting != nil {
		loginPrompt = setting.LoginPrompt
	}

	oauthProviders := uniqueStrings(h.manager.GetAvailableProviders(ctx))

	ldapSetting, err := model.GetLDAPSetting()
	if err != nil {
		klog.Warningf("Failed to load ldap setting for providers: %v", err)
	} else if ldapSetting.Enabled {
		credentialProviders = append(credentialProviders, model.AuthProviderLDAP)
	}

	credentialProviders = uniqueStrings(credentialProviders)
	providers := append(append([]string{}, credentialProviders...), oauthProviders...)

	return bootstrapAuthOptions{
		Providers:           providers,
		CredentialProviders: credentialProviders,
		OAuthProviders:      oauthProviders,
		LoginPrompt:         loginPrompt,
		MFAEnabled:          setting == nil || setting.EnableMFA,
		PasskeyLoginEnabled: setting != nil && setting.EnablePasskeyLogin,
	}
}

func (h *AuthHandler) bootstrapUser(c *gin.Context, setting *model.GeneralSetting) *model.User {
	if common.AnonymousUserEnabled {
		u := model.GetAnonymousUser(c.Request.Context())
		if u == nil {
			anonymousUser := model.AnonymousUser
			applyBootstrapSidebarPreference(&anonymousUser, setting)
			return &anonymousUser
		}
		currentUser := *u
		currentUser.Roles = model.AnonymousUser.Roles
		applyBootstrapSidebarPreference(&currentUser, setting)
		return &currentUser
	}

	tokenString, _ := c.Cookie("auth_token")
	if tokenString == "" {
		return nil
	}

	claims, err := h.manager.ValidateJWT(tokenString)
	if err != nil {
		refreshedToken, refreshErr := h.manager.RefreshJWT(c, tokenString)
		if refreshErr != nil {
			return nil
		}
		setCookieSecure(c, "auth_token", refreshedToken, common.CookieExpirationSeconds)
		claims, err = h.manager.ValidateJWT(refreshedToken)
		if err != nil {
			return nil
		}
	}

	user, err := model.GetUserByIDCached(c.Request.Context(), uint64(claims.UserID))
	if err != nil || !user.Enabled {
		return nil
	}

	currentUser := *user
	currentUser.Roles = rbac.GetUserRoles(currentUser)
	applyBootstrapSidebarPreference(&currentUser, setting)

	return &currentUser
}

func applyBootstrapSidebarPreference(user *model.User, setting *model.GeneralSetting) {
	globalSidebarPreference := strings.TrimSpace(setting.GlobalSidebarPreference)
	if globalSidebarPreference != "" && (!rbac.UserHasRole(*user, model.DefaultAdminRole.Name) || strings.TrimSpace(user.SidebarPreference) == "") {
		user.SidebarPreference = globalSidebarPreference
	}
}

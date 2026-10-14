package model

import (
	"context"
	"strings"
)

type OAuthProvider struct {
	Model
	Name         LowerCaseString `json:"name" gorm:"type:varchar(100);uniqueIndex;not null"`
	ClientID     string          `json:"clientId" gorm:"type:varchar(255);not null"`
	ClientSecret SecretString    `json:"clientSecret" gorm:"type:text;not null"`
	AuthURL      string          `json:"authUrl" gorm:"type:varchar(255)"`
	TokenURL     string          `json:"tokenUrl" gorm:"type:varchar(255)"`
	UserInfoURL  string          `json:"userInfoUrl" gorm:"type:varchar(255)"`
	Scopes       string          `json:"scopes" gorm:"type:varchar(255);default:'openid,profile,email'"`
	Issuer       string          `json:"issuer" gorm:"type:varchar(255)"`
	Enabled      bool            `json:"enabled" gorm:"type:boolean;default:true"`

	// Auto-generated redirect URL
	RedirectURL string `json:"-" gorm:"-"`
}

// GetAllOAuthProviders returns all OAuth providers from database
func GetAllOAuthProviders(ctx context.Context) ([]OAuthProvider, error) {
	var providers []OAuthProvider
	err := DB.WithContext(ctx).Find(&providers).Error
	return providers, err
}

// GetEnabledOAuthProviders returns only enabled OAuth providers
func GetEnabledOAuthProviders(ctx context.Context) ([]OAuthProvider, error) {
	var providers []OAuthProvider
	err := DB.WithContext(ctx).Where("enabled = ?", true).Find(&providers).Error
	return providers, err
}

// GetOAuthProviderByName returns an OAuth provider by name
func GetOAuthProviderByName(ctx context.Context, name string) (OAuthProvider, error) {
	var provider OAuthProvider
	name = strings.ToLower(name)
	err := DB.WithContext(ctx).Where("name = ? AND enabled = ?", name, true).First(&provider).Error
	if err != nil {
		return OAuthProvider{}, err
	}
	return provider, nil
}

// CreateOAuthProvider creates a new OAuth provider
func CreateOAuthProvider(ctx context.Context, provider *OAuthProvider) error {
	return DB.WithContext(ctx).Create(provider).Error
}

// UpdateOAuthProvider updates an existing OAuth provider
func UpdateOAuthProvider(ctx context.Context, provider *OAuthProvider, updates map[string]interface{}) error {
	return DB.WithContext(ctx).Model(provider).Updates(updates).Error
}

// DeleteOAuthProvider deletes an OAuth provider by ID
func DeleteOAuthProvider(ctx context.Context, id uint) error {
	return DB.WithContext(ctx).Delete(&OAuthProvider{}, id).Error
}

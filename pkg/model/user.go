package model

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	expirable "github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/gorm"
)

type User struct {
	Model
	Username    string       `json:"username" gorm:"type:varchar(50);uniqueIndex;not null"`
	Password    string       `json:"-" gorm:"type:varchar(255)"`
	Name        string       `json:"name,omitempty" gorm:"type:varchar(100);index"`
	AvatarURL   string       `json:"avatar_url,omitempty" gorm:"type:text"`
	Provider    string       `json:"provider,omitempty" gorm:"type:varchar(50);default:password;index"`
	OIDCGroups  SliceString  `json:"oidc_groups,omitempty" gorm:"type:text"`
	LastLoginAt *time.Time   `json:"lastLoginAt,omitempty" gorm:"type:timestamp;index"`
	Enabled     bool         `json:"enabled" gorm:"type:boolean;default:true"`
	Sub         string       `json:"sub,omitempty" gorm:"type:varchar(255);index"`
	MFAEnabled  bool         `json:"mfa_enabled" gorm:"column:mfa_enabled;type:boolean;not null;default:false"`
	MFASecret   SecretString `json:"-" gorm:"column:mfa_secret;type:text"`

	APIKey SecretString  `json:"apiKey,omitempty" gorm:"type:text"`
	Roles  []common.Role `json:"roles,omitempty" gorm:"-"`

	SidebarPreference string `json:"sidebar_preference,omitempty" gorm:"type:text"`
}

func (u *User) Key() string {
	if u.Username != "" {
		return u.Username
	}
	if u.Name != "" {
		return u.Name
	}
	if u.Sub != "" {
		return u.Sub
	}
	return fmt.Sprintf("%d", u.ID)
}

func (u *User) GetAPIKey() string {
	return fmt.Sprintf("kite%d-%s", u.ID, string(u.APIKey))
}

func AddUser(ctx context.Context, user *User) error {
	// Hash the password before storing it
	hash, err := utils.HashPassword(user.Password)
	if err != nil {
		return err
	}
	user.Password = hash
	return DB.WithContext(ctx).Create(user).Error
}

func CountUsers(ctx context.Context) (count int64, err error) {
	return count, DB.WithContext(ctx).Model(&User{}).Count(&count).Error
}

// userCache is a thread-safe LRU with 30s TTL.
// Eliminates the per-request SELECT in RequireAuth (~1-5ms → ~50ns).
// Capacity 256 is generous for a K8s dashboard user base.
var userCache = expirable.NewLRU[uint64, *User](256, nil, 30*time.Second)

// GetUserByIDCached returns the user from cache if available, otherwise
// fetches from DB and stores it.  Used on the hot auth path.
func GetUserByIDCached(ctx context.Context, id uint64) (*User, error) {
	if u, ok := userCache.Get(id); ok {
		// Return a shallow copy so callers (RequireAuth, etc.) can safely
		// mutate fields like Roles without racing on the cached pointer.
		copy := *u
		return &copy, nil
	}
	u, err := GetUserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	userCache.Add(id, u)
	// Also return a copy on miss path to keep the cached entry immutable.
	copy := *u
	return &copy, nil
}

// InvalidateUserCache removes a user from the auth cache.
// Called after every successful mutation so that security-sensitive changes
// (disable, delete, password reset) take effect on the next auth check.
func InvalidateUserCache(id uint64) {
	userCache.Remove(id)
}

func GetUserByID(ctx context.Context, id uint64) (*User, error) {
	var user User
	if err := DB.WithContext(ctx).Where("id = ?", id).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

func GetAnonymousUser(ctx context.Context) *User {
	user := &User{}
	if err := DB.WithContext(ctx).Where("username = ? AND provider = ?", "anonymous", "Anonymous").First(user).Error; err != nil {
		return nil
	}
	return user
}

func FindWithSubOrUpsertUser(ctx context.Context, user *User) error {
	if user.Sub == "" {
		return errors.New("user sub is empty")
	}
	var existingUser User
	now := time.Now()
	user.LastLoginAt = &now
	if err := DB.WithContext(ctx).Where("sub = ?", user.Sub).First(&existingUser).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return DB.WithContext(ctx).Create(user).Error
		}
		return err
	}
	user.Enabled = existingUser.Enabled

	user.ID = existingUser.ID
	user.CreatedAt = existingUser.CreatedAt
	user.SidebarPreference = existingUser.SidebarPreference
	err := DB.WithContext(ctx).Save(user).Error
	InvalidateUserCache(uint64(user.ID))
	return err
}

func GetUserByUsername(ctx context.Context, username string) (*User, error) {
	var user User
	if err := DB.WithContext(ctx).Where("username = ?", username).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

// ListUsers returns users with pagination. If limit is 0, defaults to 20.
func ListUsers(ctx context.Context, limit int, offset int, search string, sortBy string, sortOrder string, role string) (users []User, total int64, err error) {
	if limit <= 0 {
		limit = 20
	}
	query := DB.WithContext(ctx).Model(&User{}).Where("users.provider != ?", common.APIKeyProvider)
	if role != "" {
		query = query.Joins(
			"JOIN role_assignments ra ON ra.subject = users.username AND ra.subject_type = ?",
			SubjectTypeUser,
		).Joins("JOIN roles r ON r.id = ra.role_id").Where("r.name = ?", role)
	}
	if search != "" {
		likeQuery := "%" + search + "%"
		query = query.Where(
			"users.username LIKE ? OR users.name LIKE ?",
			likeQuery,
			likeQuery,
		)
	}
	countQuery := query.Select("users.id").Distinct("users.id")
	err = DB.WithContext(ctx).Table("(?) as sub", countQuery).Count(&total).Error
	if err != nil {
		return nil, 0, err
	}
	if sortOrder != "asc" && sortOrder != "desc" {
		sortOrder = "desc"
	}
	allowedSorts := map[string]string{
		"id":          "users.id",
		"createdAt":   "users.created_at",
		"lastLoginAt": "users.last_login_at",
	}
	sortColumn, ok := allowedSorts[sortBy]
	if !ok {
		sortColumn = "users.id"
	}
	orderExpr := fmt.Sprintf("%s %s", sortColumn, sortOrder)
	if sortColumn == "users.last_login_at" {
		orderExpr = fmt.Sprintf("users.last_login_at IS NULL, users.last_login_at %s", sortOrder)
	}
	var userIds []uint
	idsQuery := query.
		Select("users.id").
		Distinct("users.id").
		Order(orderExpr).
		Limit(limit).
		Offset(offset)
	err = idsQuery.Pluck("users.id", &userIds).Error
	if err != nil {
		return nil, 0, err
	}
	err = DB.WithContext(ctx).
		Where("id IN (?)", userIds).
		Order(orderExpr).
		Find(&users).Error
	if err != nil {
		return nil, 0, err
	}
	return users, total, nil
}

func LoginUser(ctx context.Context, u *User) error {
	now := time.Now()
	u.LastLoginAt = &now
	err := DB.WithContext(ctx).Model(&User{}).Where("id = ? AND enabled = ?", u.ID, true).Update("last_login_at", now).Error
	InvalidateUserCache(uint64(u.ID))
	return err
}

// DeleteUserByID removes a user by ID
func DeleteUserByID(ctx context.Context, id uint) error {
	_ = DB.WithContext(ctx).Where("operator_id = ?", id).Delete(&ResourceHistory{}).Error
	err := DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var user User
		if err := tx.Select("username").First(&user, id).Error; err != nil {
			return err
		}
		if err := tx.Where("subject_type = ? AND subject = ?", SubjectTypeUser, user.Username).Delete(&RoleAssignment{}).Error; err != nil {
			return err
		}
		return tx.Delete(&User{}, id).Error
	})
	InvalidateUserCache(uint64(id))
	return err
}

// UpdateUser saves provided user (expects ID set)
func UpdateUser(ctx context.Context, user *User) error {
	err := DB.WithContext(ctx).Save(user).Error
	InvalidateUserCache(uint64(user.ID))
	return err
}

// ResetPasswordByID sets a new password (hashed) for user with given id
func ResetPasswordByID(ctx context.Context, id uint, plainPassword string) error {
	var u User
	if err := DB.WithContext(ctx).First(&u, id).Error; err != nil {
		return err
	}
	hash, err := utils.HashPassword(plainPassword)
	if err != nil {
		return err
	}
	u.Password = hash
	err = DB.WithContext(ctx).Save(&u).Error
	InvalidateUserCache(uint64(id))
	return err
}

// SetUserEnabled sets enabled flag for a user
func SetUserEnabled(ctx context.Context, id uint, enabled bool) error {
	err := DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("enabled", enabled).Error
	InvalidateUserCache(uint64(id))
	return err
}

// UpdateUserName updates only the display name of a user.
func UpdateUserName(ctx context.Context, id uint, name string) error {
	err := DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("name", name).Error
	InvalidateUserCache(uint64(id))
	return err
}

// StoreMFASecret persists a pending MFA secret without enabling MFA yet.
func StoreMFASecret(ctx context.Context, id uint, secret string) error {
	err := DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"mfa_secret":  SecretString(secret),
		"mfa_enabled": false,
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

// EnableUserMFA marks MFA as active for the given user (secret must already be stored).
func EnableUserMFA(ctx context.Context, id uint) error {
	err := DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("mfa_enabled", true).Error
	InvalidateUserCache(uint64(id))
	return err
}

// DisableUserMFA clears MFA for the given user.
func DisableUserMFA(ctx context.Context, id uint) error {
	err := DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Updates(map[string]any{
		"mfa_enabled": false,
		"mfa_secret":  "",
	}).Error
	InvalidateUserCache(uint64(id))
	return err
}

func CheckPassword(hashedPassword, plainPassword string) bool {
	return utils.CheckPasswordHash(plainPassword, hashedPassword)
}

func UpsertLDAPUser(ctx context.Context, user *User) (*User, error) {
	if user == nil {
		return nil, errors.New("user is nil")
	}

	user.Username = strings.TrimSpace(user.Username)
	if user.Username == "" {
		return nil, errors.New("username is empty")
	}

	now := time.Now()
	user.Provider = AuthProviderLDAP
	user.Password = ""
	user.LastLoginAt = &now

	var existingUser User
	if err := DB.WithContext(ctx).Where("username = ?", user.Username).First(&existingUser).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			user.Enabled = true
			if strings.TrimSpace(user.Name) == "" {
				user.Name = user.Username
			}
			err = DB.WithContext(ctx).Create(user).Error
			if err == nil {
				InvalidateUserCache(uint64(user.ID))
				return user, nil
			}
			if !isUniqueConstraintError(err) {
				return nil, err
			}
			if err := DB.WithContext(ctx).Where("username = ?", user.Username).First(&existingUser).Error; err != nil {
				return nil, err
			}
		} else {
			return nil, err
		}
	}

	if existingUser.Provider != AuthProviderLDAP {
		return nil, ErrUserProviderConflict
	}

	user.ID = existingUser.ID
	user.CreatedAt = existingUser.CreatedAt
	user.Enabled = existingUser.Enabled
	user.SidebarPreference = existingUser.SidebarPreference
	user.Sub = existingUser.Sub
	if strings.TrimSpace(user.Name) == "" {
		user.Name = existingUser.Name
	}
	if strings.TrimSpace(user.AvatarURL) == "" {
		user.AvatarURL = existingUser.AvatarURL
	}

	err := DB.WithContext(ctx).Save(user).Error
	if err == nil {
		InvalidateUserCache(uint64(user.ID))
	}
	return user, err
}

func isUniqueConstraintError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint failed") ||
		strings.Contains(message, "duplicate key value") ||
		strings.Contains(message, "duplicate entry")
}

func AddSuperUser(ctx context.Context, user *User) error {
	if user == nil {
		return errors.New("user is nil")
	}
	if err := AddUser(ctx, user); err != nil {
		return err
	}
	if err := AddRoleAssignment(ctx, "admin", SubjectTypeUser, user.Username); err != nil {
		return err
	}
	return nil
}

func NewAPIKeyUser(ctx context.Context, name string) (*User, error) {
	apiKey := utils.RandomString(32)
	u := &User{
		Username: name,
		APIKey:   SecretString(apiKey),
		Provider: common.APIKeyProvider,
	}
	return u, DB.WithContext(ctx).Save(u).Error
}

func ListAPIKeyUsers(ctx context.Context) (users []User, err error) {
	err = DB.WithContext(ctx).Order("id desc").Where("provider = ?", common.APIKeyProvider).Find(&users).Error
	return users, err
}

// FindOrCreateAuthProxyUser finds or creates a user from auth proxy headers.
// Uses uid (stored in Sub field) as the unique identifier.
// authProxyLoginRefresh is how often an unchanged auth proxy user's
// LastLoginAt is persisted.
const authProxyLoginRefresh = 5 * time.Minute

func FindOrCreateAuthProxyUser(ctx context.Context, uid, username, name, email string, groups []string) (*User, error) {
	if uid == "" {
		return nil, errors.New("auth proxy uid is empty")
	}

	var existingUser User
	now := time.Now()

	if err := DB.WithContext(ctx).Where("sub = ?", uid).First(&existingUser).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Create new user
			newUser := &User{
				Username:    username,
				Name:        name,
				Sub:         uid,
				Provider:    common.AuthProxyProvider,
				OIDCGroups:  groups,
				Enabled:     true,
				LastLoginAt: &now,
			}
			if err := DB.WithContext(ctx).Create(newUser).Error; err != nil {
				return nil, err
			}
			return newUser, nil
		}
		return nil, err
	}

	// Skip the write when nothing changed and the login is recent: this runs
	// on every proxied request, and each write is slow on SQLite over NFS.
	if existingUser.Username == username && existingUser.Name == name &&
		slices.Equal(existingUser.OIDCGroups, groups) &&
		existingUser.LastLoginAt != nil && now.Sub(*existingUser.LastLoginAt) < authProxyLoginRefresh {
		return &existingUser, nil
	}

	// Update existing user with latest info
	existingUser.Username = username
	existingUser.Name = name
	existingUser.OIDCGroups = groups
	existingUser.LastLoginAt = &now
	if err := DB.WithContext(ctx).Save(&existingUser).Error; err != nil {
		return nil, err
	}
	InvalidateUserCache(uint64(existingUser.ID))

	return &existingUser, nil
}

var (
	ErrUserProviderConflict = errors.New("user exists with different provider")

	AnonymousUser = User{
		Model: Model{
			ID: 0,
		},
		Username: "anonymous",
		Provider: "Anonymous",
		Roles: []common.Role{
			{
				Name:       "admin",
				Clusters:   []string{"*"},
				Resources:  []string{"*"},
				Namespaces: []string{"*"},
				Verbs:      []string{"*"},
			},
		},
	}
)

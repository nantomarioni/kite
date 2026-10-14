package model

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"gorm.io/gorm"
)

type User struct {
	Model
	Username    string      `json:"username" gorm:"type:varchar(50);uniqueIndex;not null"`
	Password    string      `json:"-" gorm:"type:varchar(255)"`
	Name        string      `json:"name,omitempty" gorm:"type:varchar(100)"`
	AvatarURL   string      `json:"avatar_url,omitempty" gorm:"type:varchar(500)"`
	Provider    string      `json:"provider,omitempty" gorm:"type:varchar(50);default:password"`
	OIDCGroups  SliceString `json:"oidc_groups,omitempty" gorm:"type:text"`
	LastLoginAt *time.Time  `json:"lastLoginAt,omitempty" gorm:"type:timestamp"`
	Enabled     bool        `json:"enabled" gorm:"type:boolean;default:true"`
	Sub         string      `json:"sub,omitempty" gorm:"type:varchar(255);index"`

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
	return DB.WithContext(ctx).Save(user).Error
}

func GetUserByUsername(ctx context.Context, username string) (*User, error) {
	var user User
	if err := DB.WithContext(ctx).Where("username = ?", username).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

// ListUsers returns users with pagination. If limit is 0, defaults to 20.
func ListUsers(ctx context.Context, limit int, offset int) (users []User, total int64, err error) {
	if limit <= 0 {
		limit = 20
	}
	err = DB.WithContext(ctx).Model(&User{}).Count(&total).Error
	if err != nil {
		return
	}
	err = DB.WithContext(ctx).Order("id desc").Where("provider != ?", common.APIKeyProvider).Limit(limit).Offset(offset).Find(&users).Error
	return
}

func LoginUser(ctx context.Context, u *User) error {
	now := time.Now()
	u.LastLoginAt = &now
	return DB.WithContext(ctx).Save(u).Error
}

// DeleteUserByID removes a user by ID
func DeleteUserByID(ctx context.Context, id uint) error {
	_ = DB.WithContext(ctx).Where("operator_id = ?", id).Delete(&ResourceHistory{}).Error
	return DB.WithContext(ctx).Delete(&User{}, id).Error
}

// UpdateUser saves provided user (expects ID set)
func UpdateUser(ctx context.Context, user *User) error {
	return DB.WithContext(ctx).Save(user).Error
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
	return DB.WithContext(ctx).Save(&u).Error
}

// SetUserEnabled sets enabled flag for a user
func SetUserEnabled(ctx context.Context, id uint, enabled bool) error {
	return DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("enabled", enabled).Error
}

func CheckPassword(hashedPassword, plainPassword string) bool {
	return utils.CheckPasswordHash(plainPassword, hashedPassword)
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

	// Update existing user with latest info
	existingUser.Username = username
	existingUser.Name = name
	existingUser.OIDCGroups = groups
	existingUser.LastLoginAt = &now
	if err := DB.WithContext(ctx).Save(&existingUser).Error; err != nil {
		return nil, err
	}

	return &existingUser, nil
}

var (
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

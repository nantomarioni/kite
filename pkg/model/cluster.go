package model

import "context"

type Cluster struct {
	Model
	Name          string       `json:"name" gorm:"type:varchar(100);uniqueIndex;not null"`
	Description   string       `json:"description" gorm:"type:text"`
	Config        SecretString `json:"config" gorm:"type:text"`
	PrometheusURL string       `json:"prometheus_url,omitempty" gorm:"type:varchar(255)"`
	InCluster     bool         `json:"in_cluster" gorm:"type:boolean;default:false"`
	IsDefault     bool         `json:"is_default" gorm:"type:boolean;default:false"`
	Enable        bool         `json:"enable" gorm:"type:boolean;default:true"`
}

func AddCluster(ctx context.Context, cluster *Cluster) error {
	return DB.WithContext(ctx).Create(cluster).Error
}

func GetClusterByName(ctx context.Context, name string) (*Cluster, error) {
	var cluster Cluster
	if err := DB.WithContext(ctx).Where("name = ?", name).First(&cluster).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func GetClusterByID(ctx context.Context, id uint) (*Cluster, error) {
	var cluster Cluster
	if err := DB.WithContext(ctx).First(&cluster, id).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func UpdateCluster(ctx context.Context, cluster *Cluster, updates map[string]interface{}) error {
	return DB.WithContext(ctx).Model(cluster).Updates(updates).Error
}

func DeleteCluster(ctx context.Context, cluster *Cluster) error {
	return DB.WithContext(ctx).Delete(cluster).Error
}

func ClearDefaultCluster(ctx context.Context) error {
	return DB.WithContext(ctx).Model(&Cluster{}).Where("is_default = ?", true).Update("is_default", false).Error
}

func DisableCluster(ctx context.Context, cluster *Cluster) error {
	return DB.WithContext(ctx).Model(cluster).Update("enable", false).Error
}

func EnableCluster(ctx context.Context, cluster *Cluster) error {
	return DB.WithContext(ctx).Model(cluster).Update("enable", true).Error
}

func ListClusters(ctx context.Context) ([]*Cluster, error) {
	var clusters []*Cluster
	if err := DB.WithContext(ctx).Find(&clusters).Error; err != nil {
		return nil, err
	}
	return clusters, nil
}

func CountClusters(ctx context.Context) (count int64, err error) {
	return count, DB.WithContext(ctx).Model(&Cluster{}).Count(&count).Error
}

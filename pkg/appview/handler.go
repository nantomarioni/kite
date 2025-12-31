package appview

import (
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type AppViewResponse struct {
	Deployments  []appsv1.Deployment            `json:"deployments"`
	StatefulSets []appsv1.StatefulSet           `json:"statefulSets"`
	Services     []corev1.Service               `json:"services"`
	Ingresses    []networkingv1.Ingress         `json:"ingresses"`
	Pods         []corev1.Pod                   `json:"pods"`
	ConfigMaps   []corev1.ConfigMap             `json:"configMaps"`
	Secrets      []corev1.Secret                `json:"secrets"`
	PVCs         []corev1.PersistentVolumeClaim `json:"pvcs"`
}

func RegisterHandlers(group *gin.RouterGroup) {
	group.GET("", GetAppView)
}

func GetAppView(c *gin.Context) {
	namespace := c.Query("namespace")
	labelSelector := c.Query("labelSelector")

	if namespace == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required"})
		return
	}

	cs := c.MustGet("cluster").(*cluster.ClientSet)
	ctx := c.Request.Context()

	listOpts := []client.ListOption{
		client.InNamespace(namespace),
	}

	if labelSelector != "" {
		selector, err := labels.Parse(labelSelector)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid labelSelector: " + err.Error()})
			return
		}
		listOpts = append(listOpts, client.MatchingLabelsSelector{Selector: selector})
	}

	var resp AppViewResponse
	var mu sync.Mutex
	var wg sync.WaitGroup

	fetch := func(obj client.ObjectList, target interface{}) {
		defer wg.Done()
		if err := cs.K8sClient.List(ctx, obj, listOpts...); err != nil {
			// In a real app we might want to collect errors, but for now we just return
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch t := target.(type) {
		case *[]appsv1.Deployment:
			*t = obj.(*appsv1.DeploymentList).Items
		case *[]appsv1.StatefulSet:
			*t = obj.(*appsv1.StatefulSetList).Items
		case *[]corev1.Service:
			*t = obj.(*corev1.ServiceList).Items
		case *[]networkingv1.Ingress:
			*t = obj.(*networkingv1.IngressList).Items
		case *[]corev1.Pod:
			*t = obj.(*corev1.PodList).Items
		case *[]corev1.ConfigMap:
			*t = obj.(*corev1.ConfigMapList).Items
		case *[]corev1.Secret:
			*t = obj.(*corev1.SecretList).Items
		case *[]corev1.PersistentVolumeClaim:
			*t = obj.(*corev1.PersistentVolumeClaimList).Items
		}
	}

	wg.Add(8)
	go fetch(&appsv1.DeploymentList{}, &resp.Deployments)
	go fetch(&appsv1.StatefulSetList{}, &resp.StatefulSets)
	go fetch(&corev1.ServiceList{}, &resp.Services)
	go fetch(&networkingv1.IngressList{}, &resp.Ingresses)
	go fetch(&corev1.PodList{}, &resp.Pods)
	go fetch(&corev1.ConfigMapList{}, &resp.ConfigMaps)
	go fetch(&corev1.SecretList{}, &resp.Secrets)
	go fetch(&corev1.PersistentVolumeClaimList{}, &resp.PVCs)

	wg.Wait()

	c.JSON(http.StatusOK, resp)
}

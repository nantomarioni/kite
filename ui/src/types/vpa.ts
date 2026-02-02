// VPA (Vertical Pod Autoscaler) types
// Based on autoscaling.k8s.io/v1 API

export interface VerticalPodAutoscaler {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: Array<{
      apiVersion: string
      kind: string
      name: string
      uid: string
      controller?: boolean
      blockOwnerDeletion?: boolean
    }>
  }
  spec?: VPASpec
  status?: VPAStatus
}

export interface VPASpec {
  targetRef?: {
    apiVersion?: string
    kind?: string
    name?: string
  }
  updatePolicy?: {
    updateMode?: 'Off' | 'Initial' | 'Recreate' | 'Auto'
    minReplicas?: number
  }
  resourcePolicy?: {
    containerPolicies?: ContainerResourcePolicy[]
  }
  recommenders?: Array<{
    name: string
  }>
}

export interface ContainerResourcePolicy {
  containerName?: string
  mode?: 'Auto' | 'Off'
  minAllowed?: ResourceList
  maxAllowed?: ResourceList
  controlledResources?: string[]
  controlledValues?: 'RequestsOnly' | 'RequestsAndLimits'
}

export interface ResourceList {
  cpu?: string
  memory?: string
}

export interface VPAStatus {
  recommendation?: {
    containerRecommendations?: ContainerRecommendation[]
  }
  conditions?: VPACondition[]
}

export interface ContainerRecommendation {
  containerName?: string
  target?: ResourceList
  lowerBound?: ResourceList
  upperBound?: ResourceList
  uncappedTarget?: ResourceList
}

export interface VPACondition {
  type?: string
  status?: string
  lastTransitionTime?: string
  reason?: string
  message?: string
}

export interface VerticalPodAutoscalerList {
  apiVersion?: string
  kind?: string
  metadata?: {
    continue?: string
    remainingItemCount?: number
    resourceVersion?: string
  }
  items: VerticalPodAutoscaler[]
}

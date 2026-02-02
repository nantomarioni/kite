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
    // evictionRequirements for VPA v1beta2+ (optional)
    evictionRequirements?: Array<{
      resources?: string[]
      changeRequirement?: 'TargetHigherThanRequests' | 'TargetLowerThanRequests'
    }>
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

// Workload types for fetching target resources
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'ReplicaSet' | 'ReplicationController' | 'Job' | 'CronJob'

export interface ContainerResources {
  requests?: ResourceList
  limits?: ResourceList
}

export interface WorkloadContainer {
  name: string
  image?: string
  resources?: ContainerResources
}

// Comparison data for VPA recommendations vs current workload
export interface VPAResourceComparison {
  containerName: string
  current: {
    requests: ResourceList
    limits: ResourceList
  }
  recommended: {
    target: ResourceList
    lowerBound: ResourceList
    upperBound: ResourceList
  }
  policy?: ContainerResourcePolicy
  // Indicates if VPA is actively managing this container
  isManaged: boolean
  // Indicates if current resources match recommendations (within tolerance)
  isOptimal: boolean
  // Difference between current and recommended
  cpuDiff?: {
    requestsDiff: number // percentage difference
    limitsDiff?: number
  }
  memoryDiff?: {
    requestsDiff: number
    limitsDiff?: number
  }
}

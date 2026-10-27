import { useMemo, useState } from 'react'
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconMinus,
  IconRefresh,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Container, Pod } from 'kubernetes-types/core/v1'

import { patchResource, useResource, useResources } from '@/lib/api'
import { formatK8sResource, translateError } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { VerticalPodAutoscaler } from '@/types/vpa'
import {
  Info,
  Zap,
  AlertCircle,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react'

interface VPAResourceComparisonProps {
  vpa: VerticalPodAutoscaler
  onRefresh?: () => void
}

// Helper to parse resource values to a common unit for comparison
function parseResourceValue(
  value: string | undefined,
  type: 'cpu' | 'memory'
): number | null {
  if (!value) return null

  if (type === 'cpu') {
    // Parse CPU (can be in cores or millicores)
    if (value.endsWith('m')) {
      return parseFloat(value.slice(0, -1))
    }
    return parseFloat(value) * 1000 // Convert cores to millicores
  } else {
    // Parse memory (can be Ki, Mi, Gi, Ti, or plain bytes)
    const units: Record<string, number> = {
      '': 1,
      K: 1024,
      Ki: 1024,
      M: 1024 * 1024,
      Mi: 1024 * 1024,
      G: 1024 * 1024 * 1024,
      Gi: 1024 * 1024 * 1024,
      T: 1024 * 1024 * 1024 * 1024,
      Ti: 1024 * 1024 * 1024 * 1024,
    }

    const match = value.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/)
    if (!match) return null

    const num = parseFloat(match[1])
    const unit = match[2] || ''
    return num * (units[unit] || 1)
  }
}

// Calculate percentage difference
function calculateDiff(
  current: number | null,
  recommended: number | null
): number | null {
  if (current === null || recommended === null || current === 0) return null
  return Math.round(((recommended - current) / current) * 100)
}

// Format CPU resource for display
function formatCpu(value: string | undefined): string {
  return formatK8sResource(value, 'cpu')
}

// Format memory resource for display
function formatMem(value: string | undefined): string {
  return formatK8sResource(value, 'memory')
}

// Get diff badge color and icon
function getDiffIndicator(diff: number | null): {
  color: 'default' | 'secondary' | 'destructive' | 'outline'
  icon: React.ReactNode
  text: string
} {
  if (diff === null) {
    return {
      color: 'secondary',
      icon: <IconMinus className="w-3 h-3" />,
      text: 'N/A',
    }
  }

  if (Math.abs(diff) <= 10) {
    return {
      color: 'default',
      icon: <IconCheck className="w-3 h-3" />,
      text: `${diff >= 0 ? '+' : ''}${diff}%`,
    }
  }

  if (diff > 0) {
    return {
      color: 'destructive',
      icon: <IconArrowUp className="w-3 h-3" />,
      text: `+${diff}%`,
    }
  }

  return {
    color: 'outline',
    icon: <IconArrowDown className="w-3 h-3" />,
    text: `${diff}%`,
  }
}

export function VPAResourceComparison({
  vpa,
  onRefresh,
}: VPAResourceComparisonProps) {
  const { t } = useTranslation()
  const [isApplyDialogOpen, setIsApplyDialogOpen] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [selectedContainers, setSelectedContainers] = useState<string[]>([])

  const targetRef = vpa.spec?.targetRef
  const namespace = vpa.metadata?.namespace || ''

  // Map VPA kind to resource type for API calls
  const resourceTypeMap: Record<string, string> = {
    Deployment: 'deployments',
    StatefulSet: 'statefulsets',
    DaemonSet: 'daemonsets',
    ReplicaSet: 'replicasets',
    Job: 'jobs',
    CronJob: 'cronjobs',
  }

  const resourceType = targetRef?.kind
    ? resourceTypeMap[targetRef.kind] || 'deployments'
    : 'deployments'

  // Fetch the target workload
  const {
    data: workload,
    isLoading: isLoadingWorkload,
    error: workloadError,
    refetch: refetchWorkload,
  } = useResource(resourceType as any, targetRef?.name || '', namespace, {
    staleTime: 0,
  })

  // Get label selector from workload to fetch pods
  const labelSelector = useMemo(() => {
    if (!workload) return undefined
    const spec = (workload as any)?.spec
    if (!spec?.selector?.matchLabels) return undefined
    return Object.entries(spec.selector.matchLabels as Record<string, string>)
      .map(([key, value]) => `${key}=${value}`)
      .join(',')
  }, [workload])

  // Fetch pods for the workload to get actual running container resources
  const { data: pods, isLoading: isLoadingPods } = useResources(
    'pods',
    namespace,
    {
      labelSelector,
      disable: !labelSelector,
      staleTime: 0,
    }
  )

  // Get containers from workload (for spec/configured values)
  const workloadContainers = useMemo((): Container[] => {
    if (!workload) return []

    // Handle different workload types
    const spec = (workload as any)?.spec
    if (!spec) return []

    // For most workloads, containers are in spec.template.spec.containers
    const templateSpec = spec.template?.spec || spec.jobTemplate?.spec?.template?.spec
    return templateSpec?.containers || []
  }, [workload])

  // Get actual container resources from running pods
  // During rolling updates, pods may have different resources (old vs new pods)
  // We use the newest running pod as it will have the latest VPA-applied resources
  const actualPodContainers = useMemo((): Container[] => {
    if (!pods || pods.length === 0) return []
    
    // Filter to running pods only
    const runningPods = pods.filter((p: Pod) => p.status?.phase === 'Running')
    
    if (runningPods.length === 0) {
      // Fall back to any pod if none are running
      return pods[0]?.spec?.containers || []
    }
    
    // Sort by creation time (newest first) to get the pod with latest VPA-applied resources
    const sortedPods = [...runningPods].sort((a: Pod, b: Pod) => {
      const aTime = new Date(a.metadata?.creationTimestamp || 0).getTime()
      const bTime = new Date(b.metadata?.creationTimestamp || 0).getTime()
      return bTime - aTime // Descending order (newest first)
    })
    
    return sortedPods[0]?.spec?.containers || []
  }, [pods])

  // Get recommendations from VPA
  const recommendations = vpa.status?.recommendation?.containerRecommendations || []
  const containerPolicies = vpa.spec?.resourcePolicy?.containerPolicies || []

  // Build comparison data
  const comparisonData = useMemo(() => {
    return workloadContainers.map((container) => {
      const recommendation = recommendations.find(
        (r) => r.containerName === container.name
      )
      const policy = containerPolicies.find(
        (p) => p.containerName === container.name || p.containerName === '*'
      )

      // Get actual resources from running pod (if available)
      const actualContainer = actualPodContainers.find(
        (c) => c.name === container.name
      )
      
      // Use actual pod resources if available, fall back to workload spec
      const currentCpu = actualContainer?.resources?.requests?.cpu || container.resources?.requests?.cpu
      const currentMemory = actualContainer?.resources?.requests?.memory || container.resources?.requests?.memory
      const currentLimitCpu = actualContainer?.resources?.limits?.cpu || container.resources?.limits?.cpu
      const currentLimitMemory = actualContainer?.resources?.limits?.memory || container.resources?.limits?.memory

      const currentCpuRequests = parseResourceValue(currentCpu, 'cpu')
      const currentMemRequests = parseResourceValue(currentMemory, 'memory')
      const recommendedCpu = parseResourceValue(recommendation?.target?.cpu, 'cpu')
      const recommendedMem = parseResourceValue(
        recommendation?.target?.memory,
        'memory'
      )

      const cpuDiff = calculateDiff(currentCpuRequests, recommendedCpu)
      const memDiff = calculateDiff(currentMemRequests, recommendedMem)

      const isManaged = policy?.mode !== 'Off'
      const isOptimal =
        isManaged &&
        recommendation &&
        cpuDiff !== null &&
        memDiff !== null &&
        Math.abs(cpuDiff) <= 10 &&
        Math.abs(memDiff) <= 10

      return {
        containerName: container.name,
        current: {
          requests: {
            cpu: currentCpu,
            memory: currentMemory,
          },
          limits: {
            cpu: currentLimitCpu,
            memory: currentLimitMemory,
          },
        },
        // Also keep configured values for the Apply dialog (we patch the workload spec)
        configured: {
          requests: {
            cpu: container.resources?.requests?.cpu,
            memory: container.resources?.requests?.memory,
          },
          limits: {
            cpu: container.resources?.limits?.cpu,
            memory: container.resources?.limits?.memory,
          },
        },
        recommended: recommendation
          ? {
              target: recommendation.target || {},
              lowerBound: recommendation.lowerBound || {},
              upperBound: recommendation.upperBound || {},
              uncappedTarget: recommendation.uncappedTarget || {},
            }
          : null,
        policy,
        isManaged,
        isOptimal,
        cpuDiff,
        memDiff,
      }
    })
  }, [workloadContainers, actualPodContainers, recommendations, containerPolicies])

  // Helper to clamp a recommendation to existing limits
  const clampToLimit = (
    recommendedValue: string | undefined,
    limitValue: string | undefined,
    type: 'cpu' | 'memory'
  ): string | undefined => {
    if (!recommendedValue) return undefined
    if (!limitValue) return recommendedValue

    const recommendedParsed = parseResourceValue(recommendedValue, type)
    const limitParsed = parseResourceValue(limitValue, type)

    if (recommendedParsed === null || limitParsed === null) {
      return recommendedValue
    }

    // If recommended exceeds limit, use the limit value instead
    if (recommendedParsed > limitParsed) {
      return limitValue
    }

    return recommendedValue
  }

  // Handle applying recommendations
  const handleApplyRecommendations = async () => {
    if (!workload || !targetRef?.name) return

    setIsApplying(true)
    try {
      // Build the patch for container resources
      const containerPatches = comparisonData
        .filter(
          (c) =>
            c.recommended &&
            c.isManaged &&
            (selectedContainers.length === 0 ||
              selectedContainers.includes(c.containerName))
        )
        .map((c) => {
          // Clamp CPU and memory recommendations to not exceed configured limits (from workload spec)
          const cpuRequest = clampToLimit(
            c.recommended?.target?.cpu,
            c.configured.limits?.cpu,
            'cpu'
          )
          const memoryRequest = clampToLimit(
            c.recommended?.target?.memory,
            c.configured.limits?.memory,
            'memory'
          )

          return {
            name: c.containerName,
            resources: {
              requests: {
                ...(cpuRequest && { cpu: cpuRequest }),
                ...(memoryRequest && { memory: memoryRequest }),
              },
              // Optionally update limits based on controlledValues policy
              ...(c.policy?.controlledValues === 'RequestsAndLimits' &&
                c.configured.limits && {
                  limits: {
                    ...(c.recommended?.target?.cpu && {
                      cpu: c.recommended.target.cpu,
                    }),
                    ...(c.recommended?.target?.memory && {
                      memory: c.recommended.target.memory,
                    }),
                  },
                }),
            },
          }
        })

      if (containerPatches.length === 0) {
        toast.error(t('vpa.noContainersToUpdate', 'No containers to update'))
        return
      }

      // Create the strategic merge patch
      const patch: any = {
        spec: {
          template: {
            spec: {
              containers: containerPatches,
            },
          },
        },
      }

      // For CronJob, the path is different
      if (targetRef.kind === 'CronJob') {
        patch.spec = {
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  containers: containerPatches,
                },
              },
            },
          },
        }
      }

      await patchResource(resourceType as any, targetRef.name, namespace, patch)

      toast.success(
        t(
          'vpa.recommendationsApplied',
          'VPA recommendations applied successfully. Pods will be recreated.'
        )
      )
      setIsApplyDialogOpen(false)
      onRefresh?.()
      refetchWorkload()
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsApplying(false)
    }
  }

  // Check if there are meaningful differences to apply
  const hasMeaningfulDiff = comparisonData.some(
    (c) =>
      c.recommended &&
      c.isManaged &&
      ((c.cpuDiff !== null && Math.abs(c.cpuDiff) > 10) ||
        (c.memDiff !== null && Math.abs(c.memDiff) > 10))
  )

  const updateMode = vpa.spec?.updatePolicy?.updateMode || 'Auto'

  if (!targetRef) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">
            {t('vpa.noTarget', 'No target workload configured for this VPA.')}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Resource Comparison Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              {t('vpa.resourceComparison', 'Resource Comparison')}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="w-4 h-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    <p className="text-xs">
                      {t(
                        'vpa.resourceComparisonHelp',
                        'Compares current workload resource configuration with VPA recommendations. Green indicates optimal configuration, red indicates significant differences.'
                      )}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Link
                to={`/${resourceType}/${namespace}/${targetRef.name}`}
                className="text-blue-600 hover:text-blue-800 hover:underline text-sm"
              >
                {t('vpa.viewWorkload', 'View {{kind}}', {
                  kind: targetRef.kind,
                })}
              </Link>
              {(updateMode === 'Off' || hasMeaningfulDiff) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectedContainers([])
                    setIsApplyDialogOpen(true)
                  }}
                  disabled={!comparisonData.some((c) => c.recommended && c.isManaged)}
                >
                  <Zap className="w-4 h-4 mr-1" />
                  {t('vpa.applyRecommendations', 'Apply Recommendations')}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingWorkload || isLoadingPods ? (
            <div className="flex items-center justify-center py-4">
              <IconRefresh className="w-4 h-4 animate-spin mr-2" />
              {t('vpa.loadingWorkload', 'Loading workload...')}
            </div>
          ) : workloadError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('common.error', 'Error')}</AlertTitle>
              <AlertDescription>
                {t(
                  'vpa.workloadLoadError',
                  'Failed to load target workload. The workload may have been deleted or you may not have permission to view it.'
                )}
              </AlertDescription>
            </Alert>
          ) : comparisonData.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t(
                'vpa.noContainers',
                'No containers found in the target workload.'
              )}
            </p>
          ) : (
            <div className="space-y-4">
              {/* Summary badges */}
              <div className="flex flex-wrap gap-2">
                {comparisonData.map((c) => (
                  <Badge
                    key={c.containerName}
                    variant={
                      !c.isManaged
                        ? 'secondary'
                        : c.isOptimal
                          ? 'default'
                          : 'outline'
                    }
                    className={
                      c.isManaged && !c.isOptimal
                        ? 'border-orange-300 bg-orange-50 text-orange-700 dark:bg-orange-950/20 dark:text-orange-400'
                        : ''
                    }
                  >
                    {c.isManaged ? (
                      c.isOptimal ? (
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                      ) : (
                        <AlertTriangle className="w-3 h-3 mr-1" />
                      )
                    ) : (
                      <XCircle className="w-3 h-3 mr-1" />
                    )}
                    {c.containerName}
                    {!c.isManaged && ` (${t('vpa.excluded', 'excluded')})`}
                  </Badge>
                ))}
              </div>

              {/* Detailed comparison table */}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('vpa.container', 'Container')}</TableHead>
                      <TableHead>{t('vpa.resource', 'Resource')}</TableHead>
                      <TableHead className="text-right">
                        {t('vpa.currentRequests', 'Current Requests')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('vpa.recommendedTarget', 'Recommended')}
                      </TableHead>
                      <TableHead className="text-center">
                        {t('vpa.difference', 'Diff')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('vpa.range', 'Range (Lower - Upper)')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comparisonData.map((c) => (
                      <>
                        {/* CPU Row */}
                        <TableRow
                          key={`${c.containerName}-cpu`}
                          className={!c.isManaged ? 'opacity-50' : ''}
                        >
                          <TableCell rowSpan={2} className="font-medium">
                            <div className="flex items-center gap-2">
                              {c.containerName}
                              {!c.isManaged && (
                                <Badge variant="secondary" className="text-xs">
                                  {t('vpa.off', 'Off')}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            CPU
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatCpu(c.current.requests.cpu)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-medium">
                            {formatCpu(c.recommended?.target?.cpu)}
                          </TableCell>
                          <TableCell className="text-center">
                            {c.isManaged && c.recommended && (
                              <Badge
                                variant={getDiffIndicator(c.cpuDiff).color}
                                className="gap-1"
                              >
                                {getDiffIndicator(c.cpuDiff).icon}
                                {getDiffIndicator(c.cpuDiff).text}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {c.recommended
                              ? `${formatCpu(c.recommended.lowerBound?.cpu)} - ${formatCpu(c.recommended.upperBound?.cpu)}`
                              : '-'}
                          </TableCell>
                        </TableRow>
                        {/* Memory Row */}
                        <TableRow
                          key={`${c.containerName}-mem`}
                          className={!c.isManaged ? 'opacity-50' : ''}
                        >
                          <TableCell className="text-muted-foreground">
                            Memory
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatMem(c.current.requests.memory)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-medium">
                            {formatMem(c.recommended?.target?.memory)}
                          </TableCell>
                          <TableCell className="text-center">
                            {c.isManaged && c.recommended && (
                              <Badge
                                variant={getDiffIndicator(c.memDiff).color}
                                className="gap-1"
                              >
                                {getDiffIndicator(c.memDiff).icon}
                                {getDiffIndicator(c.memDiff).text}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {c.recommended
                              ? `${formatMem(c.recommended.lowerBound?.memory)} - ${formatMem(c.recommended.upperBound?.memory)}`
                              : '-'}
                          </TableCell>
                        </TableRow>
                      </>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-2 border-t">
                <div className="flex items-center gap-1">
                  <Badge variant="default" className="h-5">
                    <IconCheck className="w-3 h-3" />
                  </Badge>
                  <span>{t('vpa.legendOptimal', 'Optimal (within ±10%)')}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Badge variant="destructive" className="h-5">
                    <IconArrowUp className="w-3 h-3" />
                  </Badge>
                  <span>
                    {t('vpa.legendUnderprovisioned', 'Under-provisioned (needs more)')}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="h-5">
                    <IconArrowDown className="w-3 h-3" />
                  </Badge>
                  <span>
                    {t('vpa.legendOverprovisioned', 'Over-provisioned (can reduce)')}
                  </span>
                </div>
              </div>

              {/* Policy Constraints & Uncapped Targets */}
              {comparisonData.some(
                (c) =>
                  c.policy?.minAllowed ||
                  c.policy?.maxAllowed ||
                  (c.recommended?.uncappedTarget &&
                    (c.recommended.uncappedTarget.cpu !== c.recommended.target?.cpu ||
                      c.recommended.uncappedTarget.memory !== c.recommended.target?.memory))
              ) && (
                <div className="mt-4 pt-4 border-t space-y-3">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    {t('vpa.policyDetails', 'Policy Details')}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="w-3 h-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">
                            {t(
                              'vpa.policyDetailsHelp',
                              'Shows VPA resource policy constraints and uncapped recommendations. Uncapped target is what VPA would recommend without min/max constraints.'
                            )}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </h4>
                  <div className="grid gap-2">
                    {comparisonData
                      .filter(
                        (c) =>
                          c.policy?.minAllowed ||
                          c.policy?.maxAllowed ||
                          (c.recommended?.uncappedTarget &&
                            (c.recommended.uncappedTarget.cpu !== c.recommended.target?.cpu ||
                              c.recommended.uncappedTarget.memory !== c.recommended.target?.memory))
                      )
                      .map((c) => (
                        <div
                          key={c.containerName}
                          className="bg-muted/50 rounded-md p-3 text-xs space-y-1"
                        >
                          <div className="font-medium">{c.containerName}</div>
                          {(c.policy?.minAllowed || c.policy?.maxAllowed) && (
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                              {c.policy?.minAllowed && (
                                <span>
                                  {t('vpa.minAllowed', 'Min allowed')}:{' '}
                                  <span className="font-mono">
                                    CPU {formatCpu(c.policy.minAllowed.cpu)}, Mem{' '}
                                    {formatMem(c.policy.minAllowed.memory)}
                                  </span>
                                </span>
                              )}
                              {c.policy?.maxAllowed && (
                                <span>
                                  {t('vpa.maxAllowed', 'Max allowed')}:{' '}
                                  <span className="font-mono">
                                    CPU {formatCpu(c.policy.maxAllowed.cpu)}, Mem{' '}
                                    {formatMem(c.policy.maxAllowed.memory)}
                                  </span>
                                </span>
                              )}
                            </div>
                          )}
                          {c.recommended?.uncappedTarget &&
                            (c.recommended.uncappedTarget.cpu !== c.recommended.target?.cpu ||
                              c.recommended.uncappedTarget.memory !== c.recommended.target?.memory) && (
                              <div className="text-muted-foreground">
                                {t('vpa.uncappedTarget', 'Uncapped recommendation')}:{' '}
                                <span className="font-mono">
                                  CPU {formatCpu(c.recommended.uncappedTarget.cpu)}, Mem{' '}
                                  {formatMem(c.recommended.uncappedTarget.memory)}
                                </span>
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger className="ml-1">
                                      <Info className="w-3 h-3 inline" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p className="text-xs max-w-xs">
                                        {t(
                                          'vpa.uncappedHelp',
                                          'What VPA would recommend without policy min/max constraints. The actual target is capped to stay within policy limits.'
                                        )}
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            )}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Apply Recommendations Dialog */}
      <Dialog open={isApplyDialogOpen} onOpenChange={setIsApplyDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('vpa.applyRecommendationsTitle', 'Apply VPA Recommendations')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'vpa.applyRecommendationsDescription',
                'This will update the target workload ({{kind}}/{{name}}) with the VPA recommended resource values. Pods will be recreated with the new configuration.',
                {
                  kind: targetRef.kind,
                  name: targetRef.name,
                }
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>{t('common.note', 'Note')}</AlertTitle>
              <AlertDescription>
                {updateMode === 'InPlaceOrRecreate'
                  ? t(
                      'vpa.applyWarningInPlace',
                      'If your cluster supports In-Place Pod Vertical Scaling (Kubernetes 1.27+), resources may be updated without pod restart. Otherwise, a rolling update will occur.'
                    )
                  : t(
                      'vpa.applyWarning',
                      'Applying recommendations will trigger a rolling update. Existing pods will be recreated with new resource values.'
                    )}
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t('vpa.containersToUpdate', 'Containers to update:')}
              </p>
              <div className="bg-muted rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                {comparisonData
                  .filter((c) => c.recommended && c.isManaged)
                  .map((c) => (
                    <div
                      key={c.containerName}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="font-medium">{c.containerName}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        CPU: {formatCpu(c.current.requests.cpu)} →{' '}
                        {formatCpu(c.recommended?.target?.cpu)}, Mem:{' '}
                        {formatMem(c.current.requests.memory)} →{' '}
                        {formatMem(c.recommended?.target?.memory)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsApplyDialogOpen(false)}
              disabled={isApplying}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleApplyRecommendations} disabled={isApplying}>
              {isApplying ? (
                <>
                  <IconRefresh className="w-4 h-4 mr-2 animate-spin" />
                  {t('vpa.applying', 'Applying...')}
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-2" />
                  {t('vpa.applyNow', 'Apply Now')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

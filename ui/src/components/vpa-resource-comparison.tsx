import { useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconMinus,
  IconPlayerPlay,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Container } from 'kubernetes-types/core/v1'

import { patchResource, useResource } from '@/lib/api'
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

// Component to show the update mode behavior clearly
function UpdateModeBehavior({ vpa }: { vpa: VerticalPodAutoscaler }) {
  const { t } = useTranslation()
  const updateMode = vpa.spec?.updatePolicy?.updateMode || 'Auto'

  const modeInfo = useMemo(() => {
    switch (updateMode) {
      case 'Auto':
        return {
          icon: <Zap className="w-5 h-5 text-yellow-500" />,
          title: t('vpa.updateModeAuto', 'Auto (Pod Eviction)'),
          description: t(
            'vpa.updateModeAutoDescription',
            'VPA will automatically evict pods to apply resource changes. Pods will be recreated with new resource values.'
          ),
          willRecreate: true,
          isActive: true,
        }
      case 'Recreate':
        return {
          icon: <IconRefresh className="w-5 h-5 text-orange-500" />,
          title: t('vpa.updateModeRecreate', 'Recreate (Pod Eviction)'),
          description: t(
            'vpa.updateModeRecreateDescription',
            'VPA will evict pods when resource changes are needed. Same behavior as Auto mode.'
          ),
          willRecreate: true,
          isActive: true,
        }
      case 'Initial':
        return {
          icon: <IconPlayerPlay className="w-5 h-5 text-blue-500" />,
          title: t('vpa.updateModeInitial', 'Initial Only'),
          description: t(
            'vpa.updateModeInitialDescription',
            'VPA only assigns resources when pods are created. Running pods will NOT be modified.'
          ),
          willRecreate: false,
          isActive: true,
        }
      case 'Off':
        return {
          icon: <IconSettings className="w-5 h-5 text-gray-500" />,
          title: t('vpa.updateModeOff', 'Off (Recommendations Only)'),
          description: t(
            'vpa.updateModeOffDescription',
            'VPA provides recommendations but does NOT apply any changes. Manual intervention required.'
          ),
          willRecreate: false,
          isActive: false,
        }
      default:
        return {
          icon: <IconAlertTriangle className="w-5 h-5 text-gray-500" />,
          title: updateMode,
          description: t('vpa.updateModeUnknown', 'Unknown update mode'),
          willRecreate: false,
          isActive: false,
        }
    }
  }, [updateMode, t])

  return (
    <Alert
      variant={modeInfo.isActive ? 'default' : 'destructive'}
      className={
        modeInfo.isActive ? 'border-blue-200 bg-blue-50 dark:bg-blue-950/20' : ''
      }
    >
      <div className="flex items-start gap-3">
        {modeInfo.icon}
        <div className="flex-1">
          <AlertTitle className="text-sm font-semibold">
            {modeInfo.title}
          </AlertTitle>
          <AlertDescription className="text-xs mt-1">
            {modeInfo.description}
          </AlertDescription>
          <div className="flex gap-2 mt-2">
            {modeInfo.willRecreate ? (
              <Badge variant="outline" className="text-xs">
                <IconRefresh className="w-3 h-3 mr-1" />
                {t('vpa.willRecreatePods', 'Will recreate pods')}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                {t('vpa.noAutomaticChanges', 'No automatic changes')}
              </Badge>
            )}
            {!modeInfo.isActive && (
              <Badge variant="destructive" className="text-xs">
                {t('vpa.manualActionRequired', 'Manual action required')}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Alert>
  )
}

// Note about in-place updates
function InPlaceUpdateNote() {
  const { t } = useTranslation()

  return (
    <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3 flex items-start gap-2">
      <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div>
        <p className="font-medium">
          {t('vpa.inPlaceNote', 'About In-Place Pod Vertical Scaling')}
        </p>
        <p className="mt-1">
          {t(
            'vpa.inPlaceNoteDescription',
            'In-Place Pod Vertical Scaling (Kubernetes 1.27+ beta feature) allows resource changes without pod restart. However, standard VPA does not support this yet and always recreates pods. The InPlacePodVerticalScaling feature gate must be enabled on your cluster for in-place updates.'
          )}
        </p>
      </div>
    </div>
  )
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
    staleTime: 5000,
  })

  // Get containers from workload
  const workloadContainers = useMemo((): Container[] => {
    if (!workload) return []

    // Handle different workload types
    const spec = (workload as any)?.spec
    if (!spec) return []

    // For most workloads, containers are in spec.template.spec.containers
    const templateSpec = spec.template?.spec || spec.jobTemplate?.spec?.template?.spec
    return templateSpec?.containers || []
  }, [workload])

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

      const currentCpuRequests = parseResourceValue(
        container.resources?.requests?.cpu,
        'cpu'
      )
      const currentMemRequests = parseResourceValue(
        container.resources?.requests?.memory,
        'memory'
      )
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
            }
          : null,
        policy,
        isManaged,
        isOptimal,
        cpuDiff,
        memDiff,
      }
    })
  }, [workloadContainers, recommendations, containerPolicies])

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
        .map((c) => ({
          name: c.containerName,
          resources: {
            requests: {
              ...(c.recommended?.target?.cpu && {
                cpu: c.recommended.target.cpu,
              }),
              ...(c.recommended?.target?.memory && {
                memory: c.recommended.target.memory,
              }),
            },
            // Optionally update limits based on controlledValues policy
            ...(c.policy?.controlledValues === 'RequestsAndLimits' &&
              c.current.limits && {
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
        }))

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
      {/* Update Mode Behavior Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {t('vpa.updateBehavior', 'Update Behavior')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <UpdateModeBehavior vpa={vpa} />
          <InPlaceUpdateNote />
        </CardContent>
      </Card>

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
          {isLoadingWorkload ? (
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
              <IconAlertTriangle className="h-4 w-4" />
              <AlertTitle>{t('common.warning', 'Warning')}</AlertTitle>
              <AlertDescription>
                {t(
                  'vpa.applyWarning',
                  'Applying recommendations will trigger a rolling update. Existing pods will be evicted and recreated with new resource values.'
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

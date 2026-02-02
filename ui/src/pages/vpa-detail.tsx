import { useEffect, useState } from 'react'
import { IconLoader, IconRefresh, IconTrash } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { updateResource, useResource } from '@/lib/api'
import { getOwnerInfo } from '@/lib/k8s'
import { formatDate, formatK8sResource, translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { ResponsiveTabs } from '@/components/ui/responsive-tabs'
import { Badge } from '@/components/ui/badge'
import { DescribeDialog } from '@/components/describe-dialog'
import { ErrorMessage } from '@/components/error-message'
import { EventTable } from '@/components/event-table'
import { LabelsAnno } from '@/components/lables-anno'
import { ResourceDeleteConfirmationDialog } from '@/components/resource-delete-confirmation-dialog'
import { ResourceHistoryTable } from '@/components/resource-history-table'
import { YamlEditor } from '@/components/yaml-editor'
import { VPAResourceComparison } from '@/components/vpa-resource-comparison'
import { VPAMonitoring } from '@/components/vpa-monitoring'
import {
  VerticalPodAutoscaler,
  ContainerRecommendation,
  ContainerResourcePolicy,
} from '@/types/vpa'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Info } from 'lucide-react'

// Helper to format resource values for display
function formatCpu(value: string | undefined): string {
  return formatK8sResource(value, 'cpu')
}

function formatMem(value: string | undefined): string {
  return formatK8sResource(value, 'memory')
}

// Component to display container recommendations in a readable format
function ContainerRecommendationsCard({
  recommendations,
  containerPolicies,
}: {
  recommendations: ContainerRecommendation[]
  containerPolicies?: ContainerResourcePolicy[]
}) {
  const { t } = useTranslation()

  if (!recommendations || recommendations.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('vpa.recommendations', 'Resource Recommendations')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t(
              'vpa.noRecommendations',
              'No recommendations available yet. VPA needs time to analyze workload patterns.'
            )}
          </p>
        </CardContent>
      </Card>
    )
  }

  const getContainerPolicy = (containerName: string) => {
    return containerPolicies?.find(
      (p) => p.containerName === containerName || p.containerName === '*'
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {t('vpa.recommendations', 'Resource Recommendations')}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="w-4 h-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                <p className="text-xs">
                  {t(
                    'vpa.recommendationsHelp',
                    'VPA analyzes actual resource usage and recommends optimal values. Target is the recommended value, while lower/upper bounds define the safe range.'
                  )}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {recommendations.map((rec) => {
            const policy = getContainerPolicy(rec.containerName || '')
            return (
              <div
                key={rec.containerName}
                className="border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">{rec.containerName}</h4>
                  {policy?.mode && (
                    <Badge variant={policy.mode === 'Off' ? 'secondary' : 'default'}>
                      {policy.mode}
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h5 className="text-sm font-medium text-muted-foreground">
                      {t('vpa.targetRecommendation', 'Target Recommendation')}
                    </h5>
                    <div className="bg-muted/50 rounded-md p-3 space-y-1">
                      <div className="flex justify-between">
                        <span className="text-sm">CPU:</span>
                        <span className="font-mono text-sm font-medium">
                          {formatCpu(rec.target?.cpu)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm">Memory:</span>
                        <span className="font-mono text-sm font-medium">
                          {formatMem(rec.target?.memory)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h5 className="text-sm font-medium text-muted-foreground">
                      {t('vpa.bounds', 'Recommended Range')}
                    </h5>
                    <div className="bg-muted/50 rounded-md p-3 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span>Lower:</span>
                        <span className="font-mono">
                          CPU: {formatCpu(rec.lowerBound?.cpu)}, Mem:{' '}
                          {formatMem(rec.lowerBound?.memory)}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span>Upper:</span>
                        <span className="font-mono">
                          CPU: {formatCpu(rec.upperBound?.cpu)}, Mem:{' '}
                          {formatMem(rec.upperBound?.memory)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {rec.uncappedTarget && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Uncapped target:</span> CPU:{' '}
                    {formatCpu(rec.uncappedTarget.cpu)}, Memory:{' '}
                    {formatMem(rec.uncappedTarget.memory)}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger className="ml-1">
                          <Info className="w-3 h-3 inline" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-xs">
                            {t(
                              'vpa.uncappedHelp',
                              'The uncapped target is what VPA would recommend without any min/max constraints from the resource policy.'
                            )}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}

                {policy && (policy.minAllowed || policy.maxAllowed) && (
                  <div className="text-xs text-muted-foreground border-t pt-2 mt-2">
                    <span className="font-medium">Policy constraints:</span>
                    {policy.minAllowed && (
                      <span className="ml-2">
                        Min: CPU {formatCpu(policy.minAllowed.cpu)}, Mem{' '}
                        {formatMem(policy.minAllowed.memory)}
                      </span>
                    )}
                    {policy.maxAllowed && (
                      <span className="ml-2">
                        Max: CPU {formatCpu(policy.maxAllowed.cpu)}, Mem{' '}
                        {formatMem(policy.maxAllowed.memory)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// Component to show VPA conditions/status
function VPAConditionsCard({
  conditions,
}: {
  conditions?: Array<{
    type?: string
    status?: string
    lastTransitionTime?: string
    reason?: string
    message?: string
  }>
}) {
  const { t } = useTranslation()

  if (!conditions || conditions.length === 0) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t('vpa.conditions', 'Conditions')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.type', 'Type')}</TableHead>
              <TableHead>{t('common.status', 'Status')}</TableHead>
              <TableHead>{t('vpa.reason', 'Reason')}</TableHead>
              <TableHead>{t('vpa.lastTransition', 'Last Transition')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conditions.map((condition, index) => (
              <TableRow key={index}>
                <TableCell className="font-medium">{condition.type}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      condition.status === 'True' ? 'default' : 'secondary'
                    }
                  >
                    {condition.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {condition.reason || '-'}
                  {condition.message && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger className="ml-1">
                          <Info className="w-3 h-3 inline text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-xs">{condition.message}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(condition.lastTransitionTime || '')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function VPADetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const [yamlContent, setYamlContent] = useState('')
  const [isSavingYaml, setIsSavingYaml] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  const { t } = useTranslation()

  const {
    data,
    isLoading,
    isError,
    error,
    refetch: handleRefresh,
  } = useResource('verticalpodautoscalers.autoscaling.k8s.io' as any, name, namespace)

  const vpa = data as VerticalPodAutoscaler | undefined

  useEffect(() => {
    if (data) {
      setYamlContent(yaml.dump(data, { indent: 2 }))
    }
  }, [data])

  const handleSaveYaml = async (content: VerticalPodAutoscaler) => {
    setIsSavingYaml(true)
    try {
      await updateResource('verticalpodautoscalers.autoscaling.k8s.io' as any, name, namespace, content)
      toast.success(t('common.success', 'YAML saved successfully'))
      await handleRefresh()
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsSavingYaml(false)
    }
  }

  const handleYamlChange = (content: string) => {
    setYamlContent(content)
  }

  const handleManualRefresh = async () => {
    setRefreshKey((prev) => prev + 1)
    await handleRefresh()
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-center gap-2">
              <IconLoader className="animate-spin" />
              <span>{t('vpa.loading', 'Loading VPA details...')}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isError || !vpa) {
    return (
      <ErrorMessage
        resourceName="VPA"
        error={error}
        refetch={handleRefresh}
      />
    )
  }

  const targetRef = vpa.spec?.targetRef
  const updateMode = vpa.spec?.updatePolicy?.updateMode || 'Auto'
  const recommendations =
    vpa.status?.recommendation?.containerRecommendations || []
  const conditions = vpa.status?.conditions || []
  const containerPolicies = vpa.spec?.resourcePolicy?.containerPolicies

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">{name}</h1>
          <p className="text-muted-foreground">
            Namespace: <span className="font-medium">{namespace}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={isLoading}
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
          >
            <IconRefresh className="w-4 h-4" />
            {t('common.refresh', 'Refresh')}
          </Button>
          <DescribeDialog
            resourceType={'verticalpodautoscalers.autoscaling.k8s.io' as any}
            namespace={namespace}
            name={name}
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setIsDeleteDialogOpen(true)}
          >
            <IconTrash className="w-4 h-4" />
            {t('common.delete', 'Delete')}
          </Button>
        </div>
      </div>

      <ResponsiveTabs
        tabs={[
          {
            value: 'overview',
            label: t('tabs.overview', 'Overview'),
            content: (
              <div className="space-y-6">
                {/* VPA Information Card */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      {t('vpa.information', 'VPA Information')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          {t('vpa.targetWorkload', 'Target Workload')}
                        </Label>
                        {targetRef ? (
                          <p className="text-sm">
                            <Link
                              to={`/${targetRef.kind?.toLowerCase()}s/${namespace}/${targetRef.name}`}
                              className="text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {targetRef.kind}/{targetRef.name}
                            </Link>
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground">-</p>
                        )}
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          {t('vpa.updateMode', 'Update Mode')}
                        </Label>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge
                            variant={
                              updateMode === 'Auto'
                                ? 'default'
                                : updateMode === 'Off'
                                  ? 'secondary'
                                  : 'outline'
                            }
                          >
                            {updateMode}
                          </Badge>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <Info className="w-3 h-3 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p className="text-xs">
                                  {updateMode === 'Auto' &&
                                    t(
                                      'vpa.updateModeAutoHelp',
                                      'VPA will automatically update pod resources by evicting pods when needed.'
                                    )}
                                  {updateMode === 'Off' &&
                                    t(
                                      'vpa.updateModeOffHelp',
                                      'VPA will only provide recommendations without applying changes.'
                                    )}
                                  {updateMode === 'Initial' &&
                                    t(
                                      'vpa.updateModeInitialHelp',
                                      'VPA will only set resources on pod creation, not update running pods.'
                                    )}
                                  {updateMode === 'Recreate' &&
                                    t(
                                      'vpa.updateModeRecreateHelp',
                                      'VPA will evict pods that need to be updated.'
                                    )}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          {t('common.created', 'Created')}
                        </Label>
                        <p className="text-sm">
                          {formatDate(vpa.metadata?.creationTimestamp || '')}
                        </p>
                      </div>
                      {vpa.spec?.updatePolicy?.minReplicas !== undefined && (
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            {t('vpa.minReplicas', 'Min Replicas for Update')}
                          </Label>
                          <p className="text-sm">
                            {vpa.spec.updatePolicy.minReplicas}
                          </p>
                        </div>
                      )}
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          {t('common.uid', 'UID')}
                        </Label>
                        <p className="text-sm font-mono text-muted-foreground">
                          {vpa.metadata?.uid || 'N/A'}
                        </p>
                      </div>
                      {getOwnerInfo(vpa.metadata) && (
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            {t('common.owner', 'Owner')}
                          </Label>
                          <p className="text-sm">
                            {(() => {
                              const ownerInfo = getOwnerInfo(vpa.metadata)
                              if (!ownerInfo) return 'No owner'
                              return (
                                <Link
                                  to={ownerInfo.path}
                                  className="text-blue-600 hover:text-blue-800 hover:underline"
                                >
                                  {ownerInfo.kind}/{ownerInfo.name}
                                </Link>
                              )
                            })()}
                          </p>
                        </div>
                      )}
                    </div>
                    <LabelsAnno
                      labels={vpa.metadata?.labels || {}}
                      annotations={vpa.metadata?.annotations || {}}
                    />
                  </CardContent>
                </Card>

                {/* Resource Comparison - Shows current vs recommended */}
                <VPAResourceComparison
                  vpa={vpa}
                  onRefresh={handleManualRefresh}
                />

                {/* Recommendations Card */}
                <ContainerRecommendationsCard
                  recommendations={recommendations}
                  containerPolicies={containerPolicies}
                />

                {/* Conditions Card */}
                <VPAConditionsCard conditions={conditions} />
              </div>
            ),
          },
          {
            value: 'yaml',
            label: 'YAML',
            content: (
              <YamlEditor
                key={refreshKey}
                value={yamlContent}
                onChange={handleYamlChange}
                onSave={handleSaveYaml as any}
                isSaving={isSavingYaml}
              />
            ),
          },
          {
            value: 'monitoring',
            label: t('tabs.monitoring', 'Monitoring'),
            content: <VPAMonitoring vpa={vpa} namespace={namespace} />,
          },
          {
            value: 'events',
            label: t('tabs.events', 'Events'),
            content: (
              <EventTable
                resource={'verticalpodautoscalers.autoscaling.k8s.io' as any}
                name={name}
                namespace={namespace}
              />
            ),
          },
          {
            value: 'history',
            label: t('tabs.history', 'History'),
            content: (
              <ResourceHistoryTable
                resourceType={'verticalpodautoscalers.autoscaling.k8s.io' as any}
                namespace={namespace}
                name={name}
              />
            ),
          },
        ]}
      />

      <ResourceDeleteConfirmationDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        resourceName={name}
        resourceType={'verticalpodautoscalers.autoscaling.k8s.io' as any}
        namespace={namespace}
      />
    </div>
  )
}

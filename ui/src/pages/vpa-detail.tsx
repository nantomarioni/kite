import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { ResourceType } from '@/types/api'
import { VerticalPodAutoscaler } from '@/types/vpa'
import { updateResource, useResource } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { EventTable } from '@/components/event-table'
import { ResourceHistoryTable } from '@/components/resource-history-table'
import { ResourceOverview } from '@/components/resource-overview'
import { ResourceYaml } from '@/components/resource-yaml'
import { VPAMonitoring } from '@/components/vpa-monitoring'
import { VPAResourceComparison } from '@/components/vpa-resource-comparison'

import { ResourceDetailShell } from './resource-detail-shell'

// VPA is a CRD: served by the generic /:crd routes as <plural>.<group>.
const VPA_RESOURCE = 'verticalpodautoscalers.autoscaling.k8s.io' as ResourceType

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
              <TableHead>
                {t('vpa.lastTransition', 'Last Transition')}
              </TableHead>
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
                          <p className="text-xs max-w-xs">
                            {condition.message}
                          </p>
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
  const { t } = useTranslation()

  const { data, isLoading, isError, error, refetch } = useResource(
    VPA_RESOURCE,
    name,
    namespace
  )
  const vpa = data as VerticalPodAutoscaler | undefined

  const handleRefresh = async () => {
    await refetch()
  }

  const handleSaveYaml = async (content: VerticalPodAutoscaler) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateResource(VPA_RESOURCE, name, namespace, content as any)
    toast.success(t('common.messages.yamlSaved'))
    await handleRefresh()
  }

  const targetRef = vpa?.spec?.targetRef
  const updateMode = vpa?.spec?.updatePolicy?.updateMode || 'Auto'
  const updateModeHelp: Record<string, string> = {
    Auto: t(
      'vpa.updateModeAutoHelp',
      'VPA will automatically update pod resources by evicting pods when needed.'
    ),
    Off: t(
      'vpa.updateModeOffHelp',
      'VPA will only provide recommendations without applying changes.'
    ),
    Initial: t(
      'vpa.updateModeInitialHelp',
      'VPA will only set resources on pod creation, not update running pods.'
    ),
    Recreate: t(
      'vpa.updateModeRecreateHelp',
      'VPA will evict pods that need to be updated.'
    ),
    InPlaceOrRecreate: t(
      'vpa.updateModeInPlaceOrRecreateHelp',
      'VPA will attempt in-place resource updates. If not possible, pods will be evicted and recreated.'
    ),
  }

  return (
    <ResourceDetailShell
      resourceType={VPA_RESOURCE}
      resourceLabel="VPA"
      name={name}
      namespace={namespace}
      data={data}
      isLoading={isLoading}
      error={isError ? error : null}
      onRefresh={handleRefresh}
      loadingMessage={t('vpa.loading', 'Loading VPA details...')}
      tabs={[
        {
          value: 'overview',
          label: t('common.tabs.overview'),
          content: ({ onRefresh }) =>
            vpa ? (
              <ResourceOverview
                resourceType={VPA_RESOURCE}
                name={name}
                namespace={namespace}
                metadata={vpa.metadata}
                fields={[
                  {
                    label: t('vpa.targetWorkload', 'Target Workload'),
                    value: targetRef ? (
                      <Link
                        to={`/${targetRef.kind?.toLowerCase()}s/${namespace}/${targetRef.name}`}
                        className="app-link"
                      >
                        {targetRef.kind}/{targetRef.name}
                      </Link>
                    ) : (
                      '-'
                    ),
                  },
                  {
                    label: t('vpa.updateMode', 'Update Mode'),
                    value: (
                      <span className="flex items-center gap-2">
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
                        {updateModeHelp[updateMode] && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <Info className="w-3 h-3 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p className="text-xs">
                                  {updateModeHelp[updateMode]}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </span>
                    ),
                  },
                  ...(vpa.spec?.updatePolicy?.minReplicas !== undefined
                    ? [
                        {
                          label: t(
                            'vpa.minReplicas',
                            'Min Replicas for Update'
                          ),
                          value: String(vpa.spec.updatePolicy.minReplicas),
                        },
                      ]
                    : []),
                ]}
              >
                {/* Resource Comparison - Shows current vs recommended */}
                <VPAResourceComparison vpa={vpa} onRefresh={onRefresh} />
                <VPAConditionsCard conditions={vpa.status?.conditions || []} />
              </ResourceOverview>
            ) : null,
        },
        {
          value: 'yaml',
          label: t('common.tabs.yaml'),
          content: ({ resource, refreshKey }) => (
            <ResourceYaml
              key={refreshKey}
              value={resource as VerticalPodAutoscaler}
              onSave={handleSaveYaml}
              fillHeight
            />
          ),
        },
        {
          value: 'monitoring',
          label: t('common.tabs.monitor'),
          content: vpa ? (
            <VPAMonitoring vpa={vpa} namespace={namespace} />
          ) : null,
        },
        {
          value: 'events',
          label: t('common.tabs.events'),
          content: (
            <EventTable
              resource={VPA_RESOURCE}
              name={name}
              namespace={namespace}
            />
          ),
        },
        {
          value: 'history',
          label: t('common.tabs.history'),
          content: (
            <ResourceHistoryTable
              resourceType={VPA_RESOURCE}
              name={name}
              namespace={namespace}
            />
          ),
        },
      ]}
    />
  )
}

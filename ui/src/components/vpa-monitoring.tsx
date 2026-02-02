import React, { useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts'
import { useTranslation } from 'react-i18next'
import { Container } from 'kubernetes-types/core/v1'

import { usePodMetrics, useResource } from '@/lib/api'
import { formatChartXTicks, formatDate } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { ContainerSelector } from '@/components/selector/container-selector'
import { VerticalPodAutoscaler } from '@/types/vpa'
import { UsageDataPoint } from '@/types/api'

interface VPAMonitoringProps {
  vpa: VerticalPodAutoscaler
  namespace: string
}

// Parse K8s resource value to numeric (CPU in millicores, Memory in MB)
function parseResourceToNumeric(
  value: string | undefined,
  type: 'cpu' | 'memory'
): number | null {
  if (!value) return null

  if (type === 'cpu') {
    // Parse CPU to cores (decimal)
    if (value.endsWith('m')) {
      return parseFloat(value.slice(0, -1)) / 1000
    }
    return parseFloat(value)
  } else {
    // Parse memory to MB
    const units: Record<string, number> = {
      '': 1 / (1024 * 1024),
      k: 1000 / (1024 * 1024),
      K: 1024 / (1024 * 1024),
      Ki: 1024 / (1024 * 1024),
      M: 1000 * 1000 / (1024 * 1024),
      Mi: 1,
      G: 1000 * 1000 * 1000 / (1024 * 1024),
      Gi: 1024,
      T: 1000 * 1000 * 1000 * 1000 / (1024 * 1024),
      Ti: 1024 * 1024,
    }

    const match = value.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/)
    if (!match) return null

    const num = parseFloat(match[1])
    const unit = match[2] || ''
    return num * (units[unit] || 1)
  }
}

// CPU Chart with requests, limits, and usage
const VPACPUChart = React.memo(
  ({
    data,
    requests,
    limits,
    vpaTarget,
    isLoading,
    error,
    syncId,
  }: {
    data: UsageDataPoint[]
    requests: number | null
    limits: number | null
    vpaTarget: number | null
    isLoading?: boolean
    error?: Error | null
    syncId?: string
  }) => {
    const { t } = useTranslation()

    const chartData = useMemo(() => {
      if (!data) return []
      return data
        .map((point) => ({
          timestamp: point.timestamp,
          time: new Date(point.timestamp).getTime(),
          usage: point.value,
        }))
        .sort((a, b) => a.time - b.time)
    }, [data])

    const isSameDay = useMemo(() => {
      if (chartData.length < 2) return true
      const first = new Date(chartData[0].timestamp)
      const last = new Date(chartData[chartData.length - 1].timestamp)
      return first.toDateString() === last.toDateString()
    }, [chartData])

    const chartConfig = {
      usage: {
        label: t('vpa.cpuUsage', 'CPU Usage'),
        theme: {
          light: 'hsl(220, 70%, 50%)',
          dark: 'hsl(210, 80%, 60%)',
        },
      },
    } satisfies ChartConfig

    if (isLoading) {
      return (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('vpa.cpuRequestsLimitsUsage', 'CPU: Requests, Limits & Usage')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] w-full" />
          </CardContent>
        </Card>
      )
    }

    if (error) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('vpa.cpuRequestsLimitsUsage', 'CPU: Requests, Limits & Usage')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )
    }

    if (!data || data.length === 0) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('vpa.cpuRequestsLimitsUsage', 'CPU: Requests, Limits & Usage')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-[250px] w-full items-center justify-center text-muted-foreground">
              <p>{t('vpa.noMetricsData', 'No metrics data available')}</p>
            </div>
          </CardContent>
        </Card>
      )
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {t('vpa.cpuRequestsLimitsUsage', 'CPU: Requests, Limits & Usage')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-[250px] w-full">
            <AreaChart data={chartData} syncId={syncId}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value) => formatChartXTicks(value, isSameDay)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => `${value.toFixed(2)}`}
                domain={[0, 'auto']}
                label={{
                  value: 'cores',
                  angle: -90,
                  position: 'insideLeft',
                  style: { textAnchor: 'middle', fontSize: 12 },
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      if (payload?.[0]?.payload?.timestamp) {
                        return formatDate(payload[0].payload.timestamp)
                      }
                      return ''
                    }}
                    formatter={(value) => [
                      `${Number(value).toFixed(4)} cores`,
                      'Usage',
                    ]}
                  />
                }
              />
              {/* VPA Target Reference Line */}
              {vpaTarget !== null && (
                <ReferenceLine
                  y={vpaTarget}
                  stroke="hsl(142, 70%, 45%)"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{
                    value: `VPA: ${vpaTarget.toFixed(2)}`,
                    position: 'right',
                    fill: 'hsl(142, 70%, 45%)',
                    fontSize: 11,
                  }}
                />
              )}
              {/* Requests Reference Line */}
              {requests !== null && (
                <ReferenceLine
                  y={requests}
                  stroke="hsl(45, 90%, 50%)"
                  strokeDasharray="3 3"
                  strokeWidth={2}
                  label={{
                    value: `Req: ${requests.toFixed(2)}`,
                    position: 'right',
                    fill: 'hsl(45, 90%, 50%)',
                    fontSize: 11,
                  }}
                />
              )}
              {/* Limits Reference Line */}
              {limits !== null && (
                <ReferenceLine
                  y={limits}
                  stroke="hsl(0, 70%, 50%)"
                  strokeDasharray="3 3"
                  strokeWidth={2}
                  label={{
                    value: `Lim: ${limits.toFixed(2)}`,
                    position: 'right',
                    fill: 'hsl(0, 70%, 50%)',
                    fontSize: 11,
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey="usage"
                stroke="var(--color-usage)"
                fill="var(--color-usage)"
                fillOpacity={0.3}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
          {/* Legend */}
          <div className="flex flex-wrap gap-4 text-xs mt-2 justify-center">
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 bg-blue-500" />
              <span>{t('vpa.usage', 'Usage')}</span>
            </div>
            {requests !== null && (
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-0.5"
                  style={{
                    background: 'hsl(45, 90%, 50%)',
                    borderStyle: 'dashed',
                  }}
                />
                <span>{t('vpa.requests', 'Requests')}</span>
              </div>
            )}
            {limits !== null && (
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-0.5"
                  style={{
                    background: 'hsl(0, 70%, 50%)',
                    borderStyle: 'dashed',
                  }}
                />
                <span>{t('vpa.limits', 'Limits')}</span>
              </div>
            )}
            {vpaTarget !== null && (
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-0.5"
                  style={{
                    background: 'hsl(142, 70%, 45%)',
                    borderStyle: 'dashed',
                  }}
                />
                <span>{t('vpa.vpaRecommendation', 'VPA Recommendation')}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }
)

VPACPUChart.displayName = 'VPACPUChart'

// Memory Chart with requests, limits, and usage
const VPAMemoryChart = React.memo(
  ({
    data,
    requests,
    limits,
    vpaTarget,
    isLoading,
    error,
    syncId,
  }: {
    data: UsageDataPoint[]
    requests: number | null
    limits: number | null
    vpaTarget: number | null
    isLoading?: boolean
    error?: Error | null
    syncId?: string
  }) => {
    const { t } = useTranslation()

    const chartData = useMemo(() => {
      if (!data) return []
      return data
        .map((point) => ({
          timestamp: point.timestamp,
          time: new Date(point.timestamp).getTime(),
          usage: Math.max(0, point.value), // Memory is in MB
        }))
        .sort((a, b) => a.time - b.time)
    }, [data])

    const isSameDay = useMemo(() => {
      if (chartData.length < 2) return true
      const first = new Date(chartData[0].timestamp)
      const last = new Date(chartData[chartData.length - 1].timestamp)
      return first.toDateString() === last.toDateString()
    }, [chartData])

    // Determine if we should use GB instead of MB
    const useGB = useMemo(() => {
      const allValues = [
        ...chartData.map((p) => p.usage),
        requests,
        limits,
        vpaTarget,
      ].filter((v): v is number => v !== null)
      if (!allValues.length) return false
      const maxValue = Math.max(...allValues)
      return maxValue > 900
    }, [chartData, requests, limits, vpaTarget])

    // Convert data to GB if needed
    const processedData = useMemo(() => {
      if (!useGB) return chartData
      return chartData.map((point) => ({
        ...point,
        usage: point.usage / 1024,
      }))
    }, [chartData, useGB])

    const processedRequests = useGB && requests ? requests / 1024 : requests
    const processedLimits = useGB && limits ? limits / 1024 : limits
    const processedVpaTarget = useGB && vpaTarget ? vpaTarget / 1024 : vpaTarget

    const unit = useGB ? 'GB' : 'MB'

    const chartConfig = {
      usage: {
        label: t('vpa.memoryUsage', 'Memory Usage'),
        theme: {
          light: 'hsl(142, 70%, 50%)',
          dark: 'hsl(150, 80%, 60%)',
        },
      },
    } satisfies ChartConfig

    if (isLoading) {
      return (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t(
                'vpa.memoryRequestsLimitsUsage',
                'Memory: Requests, Limits & Usage'
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] w-full" />
          </CardContent>
        </Card>
      )
    }

    if (error) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              {t(
                'vpa.memoryRequestsLimitsUsage',
                'Memory: Requests, Limits & Usage'
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )
    }

    if (!data || data.length === 0) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>
              {t(
                'vpa.memoryRequestsLimitsUsage',
                'Memory: Requests, Limits & Usage'
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-[250px] w-full items-center justify-center text-muted-foreground">
              <p>{t('vpa.noMetricsData', 'No metrics data available')}</p>
            </div>
          </CardContent>
        </Card>
      )
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {t(
              'vpa.memoryRequestsLimitsUsage',
              'Memory: Requests, Limits & Usage'
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-[250px] w-full">
            <AreaChart data={processedData} syncId={syncId}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value) => formatChartXTicks(value, isSameDay)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => `${value.toFixed(0)}`}
                domain={[0, 'auto']}
                label={{
                  value: unit,
                  angle: -90,
                  position: 'insideLeft',
                  style: { textAnchor: 'middle', fontSize: 12 },
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      if (payload?.[0]?.payload?.timestamp) {
                        return formatDate(payload[0].payload.timestamp)
                      }
                      return ''
                    }}
                    formatter={(value) => [
                      `${Number(value).toFixed(1)} ${unit}`,
                      'Usage',
                    ]}
                  />
                }
              />
              {/* VPA Target Reference Line */}
              {processedVpaTarget !== null && (
                <ReferenceLine
                  y={processedVpaTarget}
                  stroke="hsl(200, 70%, 50%)"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{
                    value: `VPA: ${processedVpaTarget.toFixed(0)} ${unit}`,
                    position: 'right',
                    fill: 'hsl(200, 70%, 50%)',
                    fontSize: 11,
                  }}
                />
              )}
              {/* Requests Reference Line */}
              {processedRequests !== null && (
                <ReferenceLine
                  y={processedRequests}
                  stroke="hsl(45, 90%, 50%)"
                  strokeDasharray="3 3"
                  strokeWidth={2}
                  label={{
                    value: `Req: ${processedRequests.toFixed(0)} ${unit}`,
                    position: 'right',
                    fill: 'hsl(45, 90%, 50%)',
                    fontSize: 11,
                  }}
                />
              )}
              {/* Limits Reference Line */}
              {processedLimits !== null && (
                <ReferenceLine
                  y={processedLimits}
                  stroke="hsl(0, 70%, 50%)"
                  strokeDasharray="3 3"
                  strokeWidth={2}
                  label={{
                    value: `Lim: ${processedLimits.toFixed(0)} ${unit}`,
                    position: 'right',
                    fill: 'hsl(0, 70%, 50%)',
                    fontSize: 11,
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey="usage"
                stroke="var(--color-usage)"
                fill="var(--color-usage)"
                fillOpacity={0.3}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
          {/* Legend */}
          <div className="flex flex-wrap gap-4 text-xs mt-2 justify-center">
            <div className="flex items-center gap-1">
              <div className="w-3 h-0.5 bg-green-500" />
              <span>{t('vpa.usage', 'Usage')}</span>
            </div>
            {processedRequests !== null && (
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-0.5"
                  style={{
                    background: 'hsl(45, 90%, 50%)',
                    borderStyle: 'dashed',
                  }}
                />
                <span>{t('vpa.requests', 'Requests')}</span>
              </div>
            )}
            {processedLimits !== null && (
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-0.5"
                  style={{
                    background: 'hsl(0, 70%, 50%)',
                    borderStyle: 'dashed',
                  }}
                />
                <span>{t('vpa.limits', 'Limits')}</span>
              </div>
            )}
            {processedVpaTarget !== null && (
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-0.5"
                  style={{
                    background: 'hsl(200, 70%, 50%)',
                    borderStyle: 'dashed',
                  }}
                />
                <span>{t('vpa.vpaRecommendation', 'VPA Recommendation')}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }
)

VPAMemoryChart.displayName = 'VPAMemoryChart'

export function VPAMonitoring({ vpa, namespace }: VPAMonitoringProps) {
  const { t } = useTranslation()
  const [timeRange, setTimeRange] = useState('30m')
  const [selectedContainer, setSelectedContainer] = useState<string | undefined>(
    undefined
  )
  const [refreshInterval, setRefreshInterval] = useState(30 * 1000)

  const targetRef = vpa.spec?.targetRef

  // Map VPA kind to resource type
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

  // Fetch the target workload to get label selector
  const { data: workload } = useResource(
    resourceType as any,
    targetRef?.name || '',
    namespace,
    { staleTime: 30000 }
  )

  // Get label selector from workload
  const labelSelector = useMemo(() => {
    if (!workload) return undefined
    const spec = (workload as any)?.spec
    if (!spec?.selector?.matchLabels) return undefined
    return Object.entries(spec.selector.matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',')
  }, [workload])

  // Get containers from workload
  const containers = useMemo((): Container[] => {
    if (!workload) return []
    const spec = (workload as any)?.spec
    if (!spec) return []
    const templateSpec =
      spec.template?.spec || spec.jobTemplate?.spec?.template?.spec
    return templateSpec?.containers || []
  }, [workload])

  // Get the generate name for pod queries
  const podQueryName = useMemo(() => {
    if (!workload) return ''
    const metadata = (workload as any)?.metadata
    return metadata?.name || ''
  }, [workload])

  // Fetch pod metrics
  const { data: metricsData, isLoading, error } = usePodMetrics(
    namespace,
    podQueryName,
    timeRange,
    {
      container: selectedContainer,
      refreshInterval,
      labelSelector,
    }
  )

  // Get current container resources from workload
  const containerResources = useMemo(() => {
    const container = selectedContainer
      ? containers.find((c) => c.name === selectedContainer)
      : containers[0]

    if (!container) return { cpuReq: null, cpuLim: null, memReq: null, memLim: null }

    return {
      cpuReq: parseResourceToNumeric(container.resources?.requests?.cpu, 'cpu'),
      cpuLim: parseResourceToNumeric(container.resources?.limits?.cpu, 'cpu'),
      memReq: parseResourceToNumeric(
        container.resources?.requests?.memory,
        'memory'
      ),
      memLim: parseResourceToNumeric(
        container.resources?.limits?.memory,
        'memory'
      ),
    }
  }, [containers, selectedContainer])

  // Get VPA recommendations for the container
  const vpaRecommendations = useMemo(() => {
    const recommendations =
      vpa.status?.recommendation?.containerRecommendations || []
    const containerName = selectedContainer || containers[0]?.name

    const rec = recommendations.find((r) => r.containerName === containerName)
    if (!rec) return { cpuTarget: null, memTarget: null }

    return {
      cpuTarget: parseResourceToNumeric(rec.target?.cpu, 'cpu'),
      memTarget: parseResourceToNumeric(rec.target?.memory, 'memory'),
    }
  }, [vpa, containers, selectedContainer])

  const timeRangeOptions = [
    { value: '30m', label: t('vpa.last30min', 'Last 30 min') },
    { value: '1h', label: t('vpa.last1hour', 'Last 1 hour') },
    { value: '24h', label: t('vpa.last24hours', 'Last 24 hours') },
  ]

  const refreshIntervalOptions = [
    { value: 0, label: t('vpa.refreshOff', 'Off') },
    { value: 5 * 1000, label: t('vpa.refresh5s', '5 seconds') },
    { value: 10 * 1000, label: t('vpa.refresh10s', '10 seconds') },
    { value: 30 * 1000, label: t('vpa.refresh30s', '30 seconds') },
    { value: 60 * 1000, label: t('vpa.refresh60s', '60 seconds') },
  ]

  const simpleContainers = useMemo(() => {
    return containers.map((c) => ({
      name: c.name,
      image: c.image || '',
      ready: true,
      started: true,
      restartCount: 0,
    }))
  }, [containers])

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
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="space-y-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder={t('vpa.selectTimeRange', 'Select time range')} />
            </SelectTrigger>
            <SelectContent>
              {timeRangeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Select
            value={refreshInterval.toString()}
            onValueChange={(value) => setRefreshInterval(Number(value))}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder={t('vpa.selectRefreshInterval', 'Select refresh interval')} />
            </SelectTrigger>
            <SelectContent>
              {refreshIntervalOptions.map((option) => (
                <SelectItem key={option.value} value={option.value.toString()}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {containers.length > 1 && (
          <div className="space-y-2">
            <ContainerSelector
              containers={simpleContainers}
              selectedContainer={selectedContainer}
              onContainerChange={setSelectedContainer}
            />
          </div>
        )}
      </div>

      {metricsData?.fallback && (
        <div className="rounded bg-yellow-100 text-yellow-800 px-4 py-2 text-sm border border-yellow-300">
          {t(
            'vpa.metricsServerFallback',
            'Current data is from metrics-server, limited historical data.'
          )}
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <VPACPUChart
          data={metricsData?.cpu || []}
          requests={containerResources.cpuReq}
          limits={containerResources.cpuLim}
          vpaTarget={vpaRecommendations.cpuTarget}
          isLoading={isLoading}
          error={error}
          syncId="vpa-monitoring"
        />
        <VPAMemoryChart
          data={metricsData?.memory || []}
          requests={containerResources.memReq}
          limits={containerResources.memLim}
          vpaTarget={vpaRecommendations.memTarget}
          isLoading={isLoading}
          error={error}
          syncId="vpa-monitoring"
        />
      </div>
    </div>
  )
}

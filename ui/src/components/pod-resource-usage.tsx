import { useMemo } from 'react'
import { Container, Pod } from 'kubernetes-types/core/v1'
import { IconCpu, IconDeviceSdCard } from '@tabler/icons-react'

import { usePodMetrics } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface PodResourceUsageProps {
  pod: Pod
  namespace: string
  podName: string
}

// Parse CPU value to millicores
function parseCPU(value?: string): number {
  if (!value) return 0
  if (value.endsWith('m')) {
    return parseInt(value.slice(0, -1), 10)
  }
  if (value.endsWith('n')) {
    return parseInt(value.slice(0, -1), 10) / 1_000_000
  }
  // Plain number is cores, convert to millicores
  return parseFloat(value) * 1000
}

// Parse memory value to bytes
function parseMemory(value?: string): number {
  if (!value) return 0
  const num = parseInt(value, 10)
  if (value.endsWith('Ki')) return num * 1024
  if (value.endsWith('Mi')) return num * 1024 * 1024
  if (value.endsWith('Gi')) return num * 1024 * 1024 * 1024
  if (value.endsWith('Ti')) return num * 1024 * 1024 * 1024 * 1024
  if (value.endsWith('K')) return num * 1000
  if (value.endsWith('M')) return num * 1000 * 1000
  if (value.endsWith('G')) return num * 1000 * 1000 * 1000
  if (value.endsWith('T')) return num * 1000 * 1000 * 1000 * 1000
  return num
}

// Format CPU in millicores
function formatCPU(millicores: number): string {
  if (millicores >= 1000) {
    return `${(millicores / 1000).toFixed(2)} cores`
  }
  return `${Math.round(millicores)}m`
}

// Calculate total resources from containers
function calculatePodResources(containers?: Container[]) {
  let cpuRequest = 0
  let cpuLimit = 0
  let memoryRequest = 0
  let memoryLimit = 0

  containers?.forEach((container) => {
    cpuRequest += parseCPU(container.resources?.requests?.cpu as string)
    cpuLimit += parseCPU(container.resources?.limits?.cpu as string)
    memoryRequest += parseMemory(container.resources?.requests?.memory as string)
    memoryLimit += parseMemory(container.resources?.limits?.memory as string)
  })

  return { cpuRequest, cpuLimit, memoryRequest, memoryLimit }
}

function ResourceBar({
  label,
  icon,
  usage,
  request,
  limit,
  formatValue,
  isLoading,
}: {
  label: string
  icon: React.ReactNode
  usage: number
  request: number
  limit: number
  formatValue: (value: number) => string
  isLoading?: boolean
}) {
  // Calculate percentages based on limit (if set) or request
  const reference = limit > 0 ? limit : request > 0 ? request : usage
  const usagePercent = reference > 0 ? Math.min((usage / reference) * 100, 100) : 0
  const requestPercent = limit > 0 && request > 0 ? (request / limit) * 100 : 0

  // Determine status color
  const getStatusColor = () => {
    if (limit > 0) {
      const usageOfLimit = (usage / limit) * 100
      if (usageOfLimit >= 90) return 'bg-red-500'
      if (usageOfLimit >= 70) return 'bg-yellow-500'
    }
    if (request > 0) {
      const usageOfRequest = (usage / request) * 100
      if (usageOfRequest >= 150) return 'bg-red-500'
      if (usageOfRequest >= 100) return 'bg-yellow-500'
    }
    return 'bg-green-500'
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium text-sm">{label}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {isLoading ? (
            <Skeleton className="h-4 w-20" />
          ) : (
            <>
              <span className="font-mono font-medium">{formatValue(usage)}</span>
              {(request > 0 || limit > 0) && (
                <span className="text-muted-foreground">
                  / {limit > 0 ? formatValue(limit) : formatValue(request)}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-2 w-full" />
      ) : (
        <div className="relative h-2 bg-muted rounded-full overflow-hidden">
          {/* Request marker (if different from limit) */}
          {limit > 0 && request > 0 && request < limit && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-blue-500 z-10"
              style={{ left: `${requestPercent}%` }}
              title={`Request: ${formatValue(request)}`}
            />
          )}
          {/* Usage bar */}
          <div
            className={cn('h-full transition-all duration-300', getStatusColor())}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      )}

      {/* Labels */}
      <div className="flex justify-between text-xs text-muted-foreground">
        <div className="flex gap-3">
          {request > 0 && (
            <span>
              Request: <span className="font-mono">{formatValue(request)}</span>
            </span>
          )}
          {limit > 0 && (
            <span>
              Limit: <span className="font-mono">{formatValue(limit)}</span>
            </span>
          )}
          {request === 0 && limit === 0 && (
            <span className="italic">No requests/limits configured</span>
          )}
        </div>
        {reference > 0 && (
          <span className="font-mono">{usagePercent.toFixed(1)}%</span>
        )}
      </div>
    </div>
  )
}

export function PodResourceUsage({
  pod,
  namespace,
  podName,
}: PodResourceUsageProps) {
  // Get current metrics using 30m range (we only need the latest value)
  const { data: metrics, isLoading, error } = usePodMetrics(
    namespace,
    podName,
    '30m',
    {
      refreshInterval: 15000, // Refresh every 15 seconds
    }
  )

  // Calculate pod resource requests/limits from spec
  const resources = useMemo(() => {
    const initContainerResources = calculatePodResources(pod.spec?.initContainers)
    const containerResources = calculatePodResources(pod.spec?.containers)
    
    // For pods, we use the max of init containers or sum of regular containers
    return {
      cpuRequest: Math.max(
        initContainerResources.cpuRequest,
        containerResources.cpuRequest
      ),
      cpuLimit: Math.max(
        initContainerResources.cpuLimit,
        containerResources.cpuLimit
      ),
      memoryRequest: Math.max(
        initContainerResources.memoryRequest,
        containerResources.memoryRequest
      ),
      memoryLimit: Math.max(
        initContainerResources.memoryLimit,
        containerResources.memoryLimit
      ),
    }
  }, [pod])

  // Get current usage from metrics (latest value)
  const currentUsage = useMemo(() => {
    if (!metrics) return { cpu: 0, memory: 0 }

    // Get the latest data point
    const latestCPU = metrics.cpu?.length > 0 ? metrics.cpu[metrics.cpu.length - 1] : null
    const latestMemory = metrics.memory?.length > 0 ? metrics.memory[metrics.memory.length - 1] : null

    return {
      // CPU is in cores, convert to millicores
      cpu: latestCPU ? latestCPU.value * 1000 : 0,
      // Memory is in bytes
      memory: latestMemory ? latestMemory.value : 0,
    }
  }, [metrics])

  // Check if metrics are available
  const hasMetrics = metrics && (metrics.cpu?.length > 0 || metrics.memory?.length > 0)
  const hasResources = resources.cpuRequest > 0 || resources.cpuLimit > 0 || 
                       resources.memoryRequest > 0 || resources.memoryLimit > 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            Resource Usage
          </span>
          {hasMetrics && (
            <Badge variant="outline" className="text-xs font-normal">
              {metrics?.fallback ? 'metrics-server' : 'prometheus'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <div className="text-sm text-muted-foreground text-center py-4">
            Unable to fetch metrics
          </div>
        ) : !hasMetrics && !isLoading && !hasResources ? (
          <div className="text-sm text-muted-foreground text-center py-4">
            No metrics or resource configuration available
          </div>
        ) : (
          <>
            <ResourceBar
              label="CPU"
              icon={<IconCpu className="w-4 h-4 text-blue-500" />}
              usage={currentUsage.cpu}
              request={resources.cpuRequest}
              limit={resources.cpuLimit}
              formatValue={formatCPU}
              isLoading={isLoading}
            />
            <ResourceBar
              label="Memory"
              icon={<IconDeviceSdCard className="w-4 h-4 text-purple-500" />}
              usage={currentUsage.memory}
              request={resources.memoryRequest}
              limit={resources.memoryLimit}
              formatValue={formatBytes}
              isLoading={isLoading}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

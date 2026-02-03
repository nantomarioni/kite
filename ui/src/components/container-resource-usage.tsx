import { useState } from 'react'
import { IconRefresh } from '@tabler/icons-react'
import { Container, ContainerStatus, Pod } from 'kubernetes-types/core/v1'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { usePodMetrics } from '@/lib/api'
import { getPodStatus } from '@/lib/k8s'
import { cn, formatDate, getAge } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { PodStatusIcon } from './pod-status-icon'

const sectionLabelClassName =
  'text-balance text-xs font-medium text-muted-foreground uppercase'

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

// Parse memory value to MB
function parseMemoryToMB(value?: string): number {
  if (!value) return 0
  const num = parseInt(value, 10)
  if (value.endsWith('Ki')) return num / 1024
  if (value.endsWith('Mi')) return num
  if (value.endsWith('Gi')) return num * 1024
  if (value.endsWith('Ti')) return num * 1024 * 1024
  if (value.endsWith('K')) return num / 1000
  if (value.endsWith('M')) return num
  if (value.endsWith('G')) return num * 1000
  if (value.endsWith('T')) return num * 1000 * 1000
  // Assume bytes
  return num / 1024 / 1024
}

function formatCPU(millicores: number): string {
  if (millicores >= 1000) {
    return `${(millicores / 1000).toFixed(2)} cores`
  }
  return `${Math.round(millicores)}m`
}

function formatMemory(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} Gi`
  }
  return `${Math.round(mb)} Mi`
}

function getContainerRequests(container: Container) {
  return {
    cpuRequest: parseCPU(container.resources?.requests?.cpu as string),
    cpuLimit: parseCPU(container.resources?.limits?.cpu as string),
    memoryRequest: parseMemoryToMB(
      container.resources?.requests?.memory as string
    ),
    memoryLimit: parseMemoryToMB(container.resources?.limits?.memory as string),
  }
}

type ContainerRequests = ReturnType<typeof getContainerRequests>

function ResourceUsageBar({
  label,
  usage,
  request,
  limit,
  formatValue,
  isLoading,
  colorClass,
}: {
  label: string
  usage: number
  request: number
  limit: number
  formatValue: (value: number) => string
  isLoading?: boolean
  colorClass: string
}) {
  const reference = limit > 0 ? limit : request > 0 ? request : usage
  const usagePercent =
    reference > 0 ? Math.min((usage / reference) * 100, 100) : 0
  const requestPercent = limit > 0 && request > 0 ? (request / limit) * 100 : 0

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
    return colorClass
  }

  const formatOrDash = (value: number) => (value > 0 ? formatValue(value) : '-')

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground w-14">{label}</span>
        {isLoading ? (
          <Skeleton className="h-3 w-48" />
        ) : (
          <div className="flex items-center font-mono text-xs">
            <span className="text-green-600 dark:text-green-400">Req:</span>
            <span className="w-16 text-right">{formatOrDash(request)}</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-blue-600 dark:text-blue-400">Usage:</span>
            <span className="w-16 text-right">{formatOrDash(usage)}</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-red-600 dark:text-red-400">Limit:</span>
            <span className="w-16 text-right">{formatOrDash(limit)}</span>
          </div>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="h-1.5 w-full" />
      ) : (
        <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
          {limit > 0 && request > 0 && request < limit && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-green-500 z-10"
              style={{ left: `${requestPercent}%` }}
              title={`Request: ${formatValue(request)}`}
            />
          )}
          <div
            className={cn(
              'h-full transition-all duration-300 rounded-full',
              getStatusColor()
            )}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      )}
    </div>
  )
}

// Usage bars for one container in one pod (metrics filtered by container).
function ContainerUsageBars({
  pod,
  containerName,
  requests,
}: {
  pod: Pod
  containerName: string
  requests: ContainerRequests
}) {
  const { data: podMetrics, isLoading } = usePodMetrics(
    pod.metadata?.namespace || '',
    pod.metadata?.name || '',
    '30m',
    { refreshInterval: 15000, container: containerName }
  )

  // Latest values (CPU from cores to millicores, memory in MB)
  const cpuUsage = podMetrics?.cpu?.length
    ? podMetrics.cpu[podMetrics.cpu.length - 1].value * 1000
    : 0
  const memoryUsage = podMetrics?.memory?.length
    ? podMetrics.memory[podMetrics.memory.length - 1].value
    : 0

  return (
    <div className="space-y-1">
      <ResourceUsageBar
        label="CPU"
        usage={cpuUsage}
        request={requests.cpuRequest}
        limit={requests.cpuLimit}
        formatValue={formatCPU}
        isLoading={isLoading}
        colorClass="bg-blue-500"
      />
      <ResourceUsageBar
        label="Memory"
        usage={memoryUsage}
        request={requests.memoryRequest}
        limit={requests.memoryLimit}
        formatValue={formatMemory}
        isLoading={isLoading}
        colorClass="bg-purple-500"
      />
    </div>
  )
}

function PodContainerMetrics({
  pod,
  containerName,
  requests,
}: {
  pod: Pod
  containerName: string
  requests: ContainerRequests
}) {
  const status = getPodStatus(pod)
  return (
    <div className="border rounded p-2 space-y-2">
      <div className="flex items-center gap-2">
        <PodStatusIcon status={status.reason} className="w-3 h-3" />
        <span className="font-mono text-xs truncate flex-1">
          {pod.metadata?.name}
        </span>
        <Badge variant="outline" className="text-xs">
          {status.reason}
        </Badge>
      </div>
      <ContainerUsageBars
        pod={pod}
        containerName={containerName}
        requests={requests}
      />
    </div>
  )
}

// Previous termination of a restarted container (reason, exit code, signal).
function LastRestartInfo({ status }: { status: ContainerStatus }) {
  const terminated = status.lastState?.terminated
  if (!status.restartCount || !terminated) {
    return null
  }

  return (
    <div className="bg-muted/50 rounded-md p-3 space-y-2">
      <div className="flex items-center gap-2">
        <IconRefresh className="w-4 h-4 text-orange-500" />
        <span className="text-sm font-medium">
          Restart Count: {status.restartCount}
        </span>
        {terminated.finishedAt && (
          <span className="text-xs text-muted-foreground">
            (last restart {getAge(terminated.finishedAt)})
          </span>
        )}
      </div>
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Last Restart Reason
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-muted-foreground">Reason: </span>
          <Tooltip>
            <TooltipTrigger>
              <Badge
                variant={
                  terminated.exitCode === 0 ? 'secondary' : 'destructive'
                }
                className="ml-1"
              >
                {terminated.reason || 'Unknown'}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p>Previous termination reason</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div>
          <span className="text-muted-foreground">Exit Code: </span>
          <span
            className={
              terminated.exitCode === 0 ? 'text-green-600' : 'text-red-600'
            }
          >
            {terminated.exitCode}
          </span>
        </div>
        {terminated.signal ? (
          <div>
            <span className="text-muted-foreground">Signal: </span>
            <span className="text-red-600">{terminated.signal}</span>
          </div>
        ) : null}
        {terminated.finishedAt && (
          <div>
            <span className="text-muted-foreground">Terminated: </span>
            <span>{formatDate(terminated.finishedAt)}</span>
          </div>
        )}
      </div>
      {terminated.message && (
        <div className="mt-2 pt-2 border-t">
          <span className="text-muted-foreground text-xs">Message: </span>
          <p className="text-sm text-red-600 mt-1 font-mono bg-red-50 dark:bg-red-950/30 p-2 rounded">
            {terminated.message}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Live resource usage of a container against its requests/limits, plus the
 * reason of its last restart. Pass `pod` on a pod page (one set of bars), or
 * `pods` on a workload page (one row per pod).
 */
export function ContainerResourceUsage({
  container,
  status,
  pod,
  pods,
}: {
  container: Container
  status?: ContainerStatus
  pod?: Pod
  pods?: Pod[]
}) {
  const [isPodMetricsExpanded, setIsPodMetricsExpanded] = useState(
    () => (pods?.length || 0) <= 2
  )
  const requests = getContainerRequests(container)
  const hasPods = !!pods && pods.length > 0

  return (
    <div className="space-y-3">
      {status && <LastRestartInfo status={status} />}
      {(pod || hasPods) && (
        <div>
          <Label className={sectionLabelClassName}>Resource Usage</Label>
          <div className="mt-1">
            {pod && !hasPods && (
              <ContainerUsageBars
                pod={pod}
                containerName={container.name}
                requests={requests}
              />
            )}
            {hasPods && (
              <div>
                <div
                  className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded p-1 -ml-1"
                  onClick={() => setIsPodMetricsExpanded(!isPodMetricsExpanded)}
                >
                  {isPodMetricsExpanded ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium text-muted-foreground">
                    Resources per Pod
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {pods.length}
                  </Badge>
                </div>
                {isPodMetricsExpanded && (
                  <div className="mt-2 space-y-2 max-h-64 overflow-y-auto">
                    {pods.map((p) => (
                      <PodContainerMetrics
                        key={p.metadata?.uid || p.metadata?.name}
                        pod={p}
                        containerName={container.name}
                        requests={requests}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

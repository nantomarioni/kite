import { useState } from 'react'
import { Container, ContainerStatus, Pod } from 'kubernetes-types/core/v1'
import {
  IconAlertCircle,
  IconCircleCheck,
  IconClock,
  IconRefresh,
  IconSkull,
} from '@tabler/icons-react'
import { ChevronDown, ChevronRight, Edit3 } from 'lucide-react'

import { usePodMetrics } from '@/lib/api'
import { getPodStatus } from '@/lib/k8s'
import { cn, formatDate, getAge } from '@/lib/utils'
import { ContainerEditDialog } from './container-edit-dialog'
import { PodStatusIcon } from './pod-status-icon'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Skeleton } from './ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// Container metrics for current usage
export interface ContainerMetrics {
  cpuUsage: number // in cores (e.g., 0.5 = 500m)
  memoryUsage: number // in MB
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

// Format CPU display
function formatCPU(millicores: number): string {
  if (millicores >= 1000) {
    return `${(millicores / 1000).toFixed(2)} cores`
  }
  return `${Math.round(millicores)}m`
}

// Format memory display
function formatMemory(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} Gi`
  }
  return `${Math.round(mb)} Mi`
}

// Get state info for container status
function getStateInfo(status: ContainerStatus) {
  if (status.state?.running) {
    return {
      state: 'Running',
      icon: <IconCircleCheck className="w-4 h-4 text-green-500" />,
      details: `Started ${formatDate(status.state.running.startedAt || '')}`,
      variant: 'default' as const,
    }
  }
  if (status.state?.waiting) {
    return {
      state: status.state.waiting.reason || 'Waiting',
      icon: <IconClock className="w-4 h-4 text-yellow-500" />,
      details: status.state.waiting.message || 'Container is waiting to start',
      variant: 'secondary' as const,
    }
  }
  if (status.state?.terminated) {
    const exitCode = status.state.terminated.exitCode
    const isSuccess = exitCode === 0
    return {
      state: status.state.terminated.reason || 'Terminated',
      icon: isSuccess ? (
        <IconCircleCheck className="w-4 h-4 text-blue-500" />
      ) : (
        <IconSkull className="w-4 h-4 text-red-500" />
      ),
      details: `Exit code: ${exitCode}${status.state.terminated.message ? ` - ${status.state.terminated.message}` : ''}`,
      variant: isSuccess ? ('default' as const) : ('destructive' as const),
    }
  }
  return {
    state: 'Unknown',
    icon: <IconAlertCircle className="w-4 h-4 text-gray-500" />,
    details: 'Unknown state',
    variant: 'outline' as const,
  }
}

// Get last restart info
function getLastRestartInfo(status: ContainerStatus) {
  if (!status.lastState?.terminated) {
    return null
  }

  const terminated = status.lastState.terminated
  return {
    reason: terminated.reason || 'Unknown',
    exitCode: terminated.exitCode,
    signal: terminated.signal,
    message: terminated.message,
    finishedAt: terminated.finishedAt,
    startedAt: terminated.startedAt,
  }
}

// Resource usage bar component
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
  const usagePercent = reference > 0 ? Math.min((usage / reference) * 100, 100) : 0
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

  const formatOrDash = (value: number) => value > 0 ? formatValue(value) : '-'

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
            className={cn('h-full transition-all duration-300 rounded-full', getStatusColor())}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      )}
    </div>
  )
}

// Component to show resource usage for a specific container in a single pod
function PodContainerMetrics({
  pod,
  containerName,
  cpuRequest,
  cpuLimit,
  memoryRequest,
  memoryLimit,
}: {
  pod: Pod
  containerName: string
  cpuRequest: number
  cpuLimit: number
  memoryRequest: number
  memoryLimit: number
}) {
  const namespace = pod.metadata?.namespace || ''
  const podName = pod.metadata?.name || ''
  const status = getPodStatus(pod)

  const { data: podMetrics, isLoading: metricsLoading } = usePodMetrics(
    namespace,
    podName,
    '30m',
    { refreshInterval: 15000, container: containerName }
  )

  // Get latest metrics values (convert CPU from cores to millicores)
  const cpuUsage = podMetrics?.cpu?.length
    ? podMetrics.cpu[podMetrics.cpu.length - 1].value * 1000
    : 0
  const memoryUsage = podMetrics?.memory?.length
    ? podMetrics.memory[podMetrics.memory.length - 1].value
    : 0

  return (
    <div className="border rounded p-2 space-y-2">
      <div className="flex items-center gap-2">
        <PodStatusIcon status={status.reason} className="w-3 h-3" />
        <span className="font-mono text-xs truncate flex-1">{podName}</span>
        <Badge variant="outline" className="text-xs">
          {status.reason}
        </Badge>
      </div>
      <div className="space-y-1">
        <ResourceUsageBar
          label="CPU"
          usage={cpuUsage}
          request={cpuRequest}
          limit={cpuLimit}
          formatValue={formatCPU}
          isLoading={metricsLoading}
          colorClass="bg-blue-500"
        />
        <ResourceUsageBar
          label="Memory"
          usage={memoryUsage}
          request={memoryRequest}
          limit={memoryLimit}
          formatValue={formatMemory}
          isLoading={metricsLoading}
          colorClass="bg-purple-500"
        />
      </div>
    </div>
  )
}

export function ContainerTable(props: {
  container: Container
  onContainerUpdate?: (updatedContainer: Container) => void
  init?: boolean
  metrics?: ContainerMetrics
  metricsLoading?: boolean
  containerStatus?: ContainerStatus
  pods?: Pod[]  // Optional: for workloads with multiple pods (deployments, etc.)
}) {
  const { container, onContainerUpdate, init, metrics, metricsLoading, containerStatus, pods } = props
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isPodMetricsExpanded, setIsPodMetricsExpanded] = useState(() => (pods?.length || 0) <= 2)

  const handleContainerUpdate = (updatedContainer: Container) => {
    onContainerUpdate?.(updatedContainer)
  }

  // Parse resource values
  const cpuRequest = parseCPU(container.resources?.requests?.cpu as string)
  const cpuLimit = parseCPU(container.resources?.limits?.cpu as string)
  const memoryRequest = parseMemoryToMB(container.resources?.requests?.memory as string)
  const memoryLimit = parseMemoryToMB(container.resources?.limits?.memory as string)

  // Current usage (convert CPU from cores to millicores)
  const cpuUsage = metrics ? metrics.cpuUsage * 1000 : 0
  const memoryUsage = metrics ? metrics.memoryUsage : 0

  const hasResources = cpuRequest > 0 || cpuLimit > 0 || memoryRequest > 0 || memoryLimit > 0
  const hasMetrics = metrics !== undefined
  const hasPods = pods && pods.length > 0

  // Get status info if available
  const stateInfo = containerStatus ? getStateInfo(containerStatus) : null
  const lastRestart = containerStatus ? getLastRestartInfo(containerStatus) : null
  const hasRestarts = (containerStatus?.restartCount || 0) > 0

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        {/* Container Header */}
        <div
          className={`${isExpanded ? 'border-b' : ''} bg-muted/30 p-4 cursor-pointer hover:bg-muted/50 transition-colors`}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <Badge variant="default" className="font-medium">
                  {container.name}
                </Badge>
              </div>
              <span className="text-sm text-muted-foreground font-mono">
                {container.image}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Container Status Badge */}
              {stateInfo && (
                <div className="flex items-center gap-1">
                  {stateInfo.icon}
                  <Badge variant={stateInfo.variant} className="text-xs">
                    {stateInfo.state}
                  </Badge>
                </div>
              )}
              {/* Restart count indicator */}
              {hasRestarts && (
                <Badge variant="outline" className="text-xs text-orange-600">
                  <IconRefresh className="w-3 h-3 mr-1" />
                  {containerStatus?.restartCount}
                </Badge>
              )}
              {init && container.restartPolicy === 'Always' && (
                <Badge variant="secondary" className="text-xs">
                  Sidecar
                </Badge>
              )}
              {container.imagePullPolicy && (
                <Badge variant="outline" className="text-xs">
                  {container.imagePullPolicy}
                </Badge>
              )}
              {onContainerUpdate && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditDialogOpen(true)
                  }}
                  className="h-8 w-8 p-0"
                >
                  <Edit3 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Container Details */}
        {isExpanded && (
          <div className="p-4 space-y-4">
            {/* Container Status Section */}
            {containerStatus && (
              <div className="border-b pb-4">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Status
                </Label>
                <div className="mt-2 space-y-3">
                  {/* Current state details */}
                  {stateInfo && (
                    <div className="text-sm text-muted-foreground">{stateInfo.details}</div>
                  )}
                  
                  {/* Restart information */}
                  {hasRestarts && (
                    <div className="bg-muted/50 rounded-md p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <IconRefresh className="w-4 h-4 text-orange-500" />
                        <span className="text-sm font-medium">
                          Restart Count: {containerStatus.restartCount}
                        </span>
                        {lastRestart?.finishedAt && (
                          <span className="text-xs text-muted-foreground">
                            (last restart {getAge(lastRestart.finishedAt)})
                          </span>
                        )}
                      </div>

                      {lastRestart && (
                        <div className="space-y-2">
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
                                      lastRestart.exitCode === 0
                                        ? 'secondary'
                                        : 'destructive'
                                    }
                                    className="ml-1"
                                  >
                                    {lastRestart.reason}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Previous termination reason</p>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                            {lastRestart.exitCode !== undefined && (
                              <div>
                                <span className="text-muted-foreground">Exit Code: </span>
                                <span
                                  className={
                                    lastRestart.exitCode === 0
                                      ? 'text-green-600'
                                      : 'text-red-600'
                                  }
                                >
                                  {lastRestart.exitCode}
                                </span>
                              </div>
                            )}
                            {lastRestart.signal && (
                              <div>
                                <span className="text-muted-foreground">Signal: </span>
                                <span className="text-red-600">{lastRestart.signal}</span>
                              </div>
                            )}
                            {lastRestart.finishedAt && (
                              <div>
                                <span className="text-muted-foreground">Terminated: </span>
                                <span>{formatDate(lastRestart.finishedAt)}</span>
                              </div>
                            )}
                          </div>
                          {lastRestart.message && (
                            <div className="mt-2 pt-2 border-t">
                              <span className="text-muted-foreground text-xs">Message: </span>
                              <p className="text-sm text-red-600 mt-1 font-mono bg-red-50 dark:bg-red-950/30 p-2 rounded">
                                {lastRestart.message}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Basic Info - Always show in a consistent layout */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Ports */}
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Ports
                </Label>
                <div className="mt-1 min-h-[24px]">
                  {container.ports && container.ports.length > 0 ? (
                    <div className="space-y-1">
                      {container.ports.map((port, portIndex) => (
                        <div
                          key={portIndex}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Badge variant="secondary" className="text-xs">
                            {port.containerPort}
                          </Badge>
                          {port.protocol && (
                            <span className="text-muted-foreground">
                              {port.protocol}
                            </span>
                          )}
                          {port.name && (
                            <span className="text-muted-foreground">
                              ({port.name})
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No ports exposed
                    </div>
                  )}
                </div>
              </div>

              {/* Resources */}
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Resources
                </Label>
                <div className="mt-1 min-h-[24px]">
                  {hasResources || hasMetrics || metricsLoading || hasPods ? (
                    <div className="space-y-3">
                      {/* Single pod mode: show usage bars directly */}
                      {!hasPods && (
                        <>
                          {/* CPU Usage Bar */}
                          {(hasMetrics || metricsLoading || cpuRequest > 0 || cpuLimit > 0) && (
                            <ResourceUsageBar
                              label="CPU"
                              usage={cpuUsage}
                              request={cpuRequest}
                              limit={cpuLimit}
                              formatValue={formatCPU}
                              isLoading={metricsLoading}
                              colorClass="bg-blue-500"
                            />
                          )}
                          {/* Memory Usage Bar */}
                          {(hasMetrics || metricsLoading || memoryRequest > 0 || memoryLimit > 0) && (
                            <ResourceUsageBar
                              label="Memory"
                              usage={memoryUsage}
                              request={memoryRequest}
                              limit={memoryLimit}
                              formatValue={formatMemory}
                              isLoading={metricsLoading}
                              colorClass="bg-purple-500"
                            />
                          )}
                        </>
                      )}

                      {/* Multi-pod mode: show per-pod metrics */}
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
                              {pods.map((pod) => (
                                <PodContainerMetrics
                                  key={pod.metadata?.uid || pod.metadata?.name}
                                  pod={pod}
                                  containerName={container.name}
                                  cpuRequest={cpuRequest}
                                  cpuLimit={cpuLimit}
                                  memoryRequest={memoryRequest}
                                  memoryLimit={memoryLimit}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No resource configured
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Environment Variables - Full width when present */}
            {((container.env && container.env.length > 0) ||
              (container.envFrom && container.envFrom.length > 0)) && (
              <div className="border-t pt-3">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Environment Variables
                  {container.env &&
                    container.env.length > 0 &&
                    ` (${container.env.length})`}
                </Label>
                <div className="mt-2 space-y-3">
                  {/* Direct environment variables */}
                  {container.env && container.env.length > 0 && (
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {container.env.slice(0, 5).map((envVar, envIndex) => (
                        <div key={envIndex} className="text-sm">
                          <div className=" text-xs">
                            <span className="text-blue-600 dark:text-blue-400 font-mono">
                              {envVar.name}
                            </span>
                            {envVar.value && (
                              <>
                                <span className="text-muted-foreground">=</span>
                                <span className="text-muted-foreground truncate font-mono">
                                  {envVar.value}
                                </span>
                              </>
                            )}
                            {envVar.valueFrom && (
                              <span className="text-orange-600 dark:text-orange-400 ml-1">
                                (from{' '}
                                {envVar.valueFrom.secretKeyRef
                                  ? 'secret'
                                  : envVar.valueFrom.configMapKeyRef
                                    ? 'configmap'
                                    : envVar.valueFrom.fieldRef
                                      ? 'field'
                                      : 'ref'}
                                )
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {container.env.length > 5 && (
                        <div className="text-xs text-muted-foreground">
                          ... and {container.env.length - 5} more
                        </div>
                      )}
                    </div>
                  )}

                  {/* Environment variables from sources */}
                  {container.envFrom && container.envFrom.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-purple-600 dark:text-purple-400 mb-2">
                        Environment From Sources ({container.envFrom.length})
                      </div>
                      <div className="space-y-1">
                        {container.envFrom.map(
                          (envFromSource, envFromIndex) => (
                            <div key={envFromIndex} className="text-sm">
                              <div className="flex items-center gap-2">
                                {envFromSource.configMapRef && (
                                  <>
                                    <Badge
                                      variant="outline"
                                      className="text-xs bg-blue-50 dark:bg-blue-950"
                                    >
                                      ConfigMap
                                    </Badge>
                                    <span className=" text-xs text-blue-600 dark:text-blue-400">
                                      {envFromSource.configMapRef.name}
                                    </span>
                                    {envFromSource.configMapRef.optional && (
                                      <Badge
                                        variant="secondary"
                                        className="text-xs"
                                      >
                                        Optional
                                      </Badge>
                                    )}
                                  </>
                                )}
                                {envFromSource.secretRef && (
                                  <>
                                    <Badge
                                      variant="outline"
                                      className="text-xs bg-green-50 dark:bg-green-950"
                                    >
                                      Secret
                                    </Badge>
                                    <span className=" text-xs text-green-600 dark:text-green-400">
                                      {envFromSource.secretRef.name}
                                    </span>
                                    {envFromSource.secretRef.optional && (
                                      <Badge
                                        variant="secondary"
                                        className="text-xs"
                                      >
                                        Optional
                                      </Badge>
                                    )}
                                  </>
                                )}
                                {envFromSource.prefix && (
                                  <span className="text-xs text-muted-foreground">
                                    (prefix: {envFromSource.prefix})
                                  </span>
                                )}
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Additional Info - Always show with consistent layout */}
            <div className="border-t pt-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Volume Mounts */}
                <div>
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Volume Mounts
                  </Label>
                  <div className="mt-1 min-h-[24px]">
                    {container.volumeMounts &&
                    container.volumeMounts.length > 0 ? (
                      <div className="space-y-1">
                        {container.volumeMounts
                          .slice(0, 3)
                          .map((mount, mountIndex) => (
                            <div key={mountIndex} className="text-sm">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-xs">
                                  {mount.name}
                                </Badge>
                                <span className="text-muted-foreground  text-xs font-mono">
                                  {mount.mountPath}
                                </span>
                                {mount.readOnly && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    RO
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        {container.volumeMounts.length > 3 && (
                          <div className="text-xs text-muted-foreground">
                            ... and {container.volumeMounts.length - 3} more
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        No volume mounts
                      </div>
                    )}
                  </div>
                </div>

                {/* Probes */}
                <div>
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Health Checks
                  </Label>
                  <div className="mt-1 min-h-[24px]">
                    {container.livenessProbe ||
                    container.readinessProbe ||
                    container.startupProbe ? (
                      <div className="space-y-1">
                        {container.livenessProbe && (
                          <div className="flex items-center gap-2 text-sm">
                            <Badge
                              variant="outline"
                              className="text-xs bg-green-50 dark:bg-green-950"
                            >
                              Liveness
                            </Badge>
                            <span className="text-muted-foreground text-xs">
                              {container.livenessProbe.httpGet
                                ? 'HTTP'
                                : container.livenessProbe.tcpSocket
                                  ? 'TCP'
                                  : container.livenessProbe.exec
                                    ? 'Exec'
                                    : 'Custom'}
                            </span>
                          </div>
                        )}
                        {container.readinessProbe && (
                          <div className="flex items-center gap-2 text-sm">
                            <Badge
                              variant="outline"
                              className="text-xs bg-blue-50 dark:bg-blue-950"
                            >
                              Readiness
                            </Badge>
                            <span className="text-muted-foreground text-xs">
                              {container.readinessProbe.httpGet
                                ? 'HTTP'
                                : container.readinessProbe.tcpSocket
                                  ? 'TCP'
                                  : container.readinessProbe.exec
                                    ? 'Exec'
                                    : 'Custom'}
                            </span>
                          </div>
                        )}
                        {container.startupProbe && (
                          <div className="flex items-center gap-2 text-sm">
                            <Badge
                              variant="outline"
                              className="text-xs bg-yellow-50 dark:bg-yellow-950"
                            >
                              Startup
                            </Badge>
                            <span className="text-muted-foreground text-xs">
                              {container.startupProbe.httpGet
                                ? 'HTTP'
                                : container.startupProbe.tcpSocket
                                  ? 'TCP'
                                  : container.startupProbe.exec
                                    ? 'Exec'
                                    : 'Custom'}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        No health checks configured
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <ContainerEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        container={container}
        onSave={handleContainerUpdate}
      />
    </>
  )
}

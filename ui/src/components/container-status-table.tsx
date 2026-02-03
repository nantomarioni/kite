import { ContainerStatus } from 'kubernetes-types/core/v1'
import {
  IconAlertCircle,
  IconCircleCheck,
  IconClock,
  IconRefresh,
  IconSkull,
} from '@tabler/icons-react'

import { formatDate, getAge } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface ContainerStatusTableProps {
  containerStatuses?: ContainerStatus[]
  initContainerStatuses?: ContainerStatus[]
}

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

function getLastRestartInfo(status: ContainerStatus) {
  if (!status.lastState?.terminated) {
    return null
  }

  const terminated = status.lastState.terminated
  const exitCode = terminated.exitCode
  const signal = terminated.signal
  const reason = terminated.reason || 'Unknown'
  const message = terminated.message
  const finishedAt = terminated.finishedAt
  const startedAt = terminated.startedAt

  return {
    reason,
    exitCode,
    signal,
    message,
    finishedAt,
    startedAt,
  }
}

function ContainerStatusRow({
  status,
  isInit,
}: {
  status: ContainerStatus
  isInit?: boolean
}) {
  const stateInfo = getStateInfo(status)
  const lastRestart = getLastRestartInfo(status)
  const hasRestarts = (status.restartCount || 0) > 0

  return (
    <div className="border rounded-lg p-4 space-y-3">
      {/* Header row with container name and current state */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {status.name}
          </Badge>
          {isInit && (
            <Badge variant="secondary" className="text-xs">
              Init
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {stateInfo.icon}
          <Badge variant={stateInfo.variant}>{stateInfo.state}</Badge>
        </div>
      </div>

      {/* Current state details */}
      <div className="text-sm text-muted-foreground">{stateInfo.details}</div>

      {/* Restart information */}
      {hasRestarts && (
        <div className="border-t pt-3 mt-3">
          <div className="flex items-center gap-2 mb-2">
            <IconRefresh className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-medium">
              Restart Count: {status.restartCount}
            </span>
            {lastRestart?.finishedAt && (
              <span className="text-xs text-muted-foreground">
                (last restart {getAge(lastRestart.finishedAt)})
              </span>
            )}
          </div>

          {lastRestart && (
            <div className="bg-muted/50 rounded-md p-3 space-y-2">
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
                  <span className="text-muted-foreground text-xs">
                    Message:{' '}
                  </span>
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
  )
}

export function ContainerStatusTable({
  containerStatuses,
  initContainerStatuses,
}: ContainerStatusTableProps) {
  const hasAnyRestarts =
    containerStatuses?.some((s) => (s.restartCount || 0) > 0) ||
    initContainerStatuses?.some((s) => (s.restartCount || 0) > 0)

  if (!containerStatuses?.length && !initContainerStatuses?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconRefresh className="w-5 h-5" />
            Container Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No container status information available
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconRefresh className="w-5 h-5" />
          Container Status
          {hasAnyRestarts && (
            <Badge variant="outline" className="ml-2 text-orange-600">
              Has Restarts
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Init Container Statuses */}
        {initContainerStatuses && initContainerStatuses.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">
              Init Containers
            </h4>
            {initContainerStatuses.map((status) => (
              <ContainerStatusRow key={status.name} status={status} isInit />
            ))}
          </div>
        )}

        {/* Regular Container Statuses */}
        {containerStatuses && containerStatuses.length > 0 && (
          <div className="space-y-3">
            {initContainerStatuses && initContainerStatuses.length > 0 && (
              <h4 className="text-sm font-medium text-muted-foreground">
                Containers
              </h4>
            )}
            {containerStatuses.map((status) => (
              <ContainerStatusRow key={status.name} status={status} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

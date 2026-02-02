import { useCallback, useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Link } from 'react-router-dom'

import { formatDate } from '@/lib/utils'
import { ResourceTable } from '@/components/resource-table'
import { VerticalPodAutoscaler } from '@/types/vpa'
import { Badge } from '@/components/ui/badge'

function getVpaTargetInfo(vpa: VerticalPodAutoscaler): string {
  if (!vpa.spec?.targetRef) {
    return '-'
  }
  const { kind, name } = vpa.spec.targetRef
  return `${kind}/${name}`
}

function getUpdateMode(vpa: VerticalPodAutoscaler): string {
  return vpa.spec?.updatePolicy?.updateMode || 'Auto'
}

function formatResourceValue(value: string | undefined): string {
  if (!value) return '-'
  return value
}

function getContainerRecommendations(vpa: VerticalPodAutoscaler) {
  return vpa.status?.recommendation?.containerRecommendations || []
}

export function VPAListPage() {
  const columnHelper = createColumnHelper<VerticalPodAutoscaler>()

  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: 'Name',
        cell: ({ row }) => (
          <div className="font-medium text-blue-500 hover:underline">
            <Link
              to={`/verticalpodautoscalers/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => getVpaTargetInfo(row), {
        id: 'target',
        header: 'Target',
        cell: ({ getValue }) => getValue(),
      }),
      columnHelper.accessor((row) => getUpdateMode(row), {
        id: 'updateMode',
        header: 'Update Mode',
        cell: ({ getValue }) => {
          const mode = getValue()
          return (
            <Badge
              variant={
                mode === 'Auto'
                  ? 'default'
                  : mode === 'Off'
                    ? 'secondary'
                    : 'outline'
              }
            >
              {mode}
            </Badge>
          )
        },
      }),
      columnHelper.accessor((row) => getContainerRecommendations(row).length, {
        id: 'containers',
        header: 'Containers',
        cell: ({ getValue, row }) => {
          const count = getValue()
          const recommendations = getContainerRecommendations(row.original)
          if (count === 0) return <span className="text-muted-foreground">No recommendations</span>
          
          return (
            <div className="flex flex-col gap-1">
              {recommendations.slice(0, 2).map((rec) => (
                <div key={rec.containerName} className="text-xs">
                  <span className="font-medium">{rec.containerName}:</span>{' '}
                  <span className="text-muted-foreground">
                    CPU: {formatResourceValue(rec.target?.cpu)}, Mem: {formatResourceValue(rec.target?.memory)}
                  </span>
                </div>
              ))}
              {count > 2 && (
                <span className="text-xs text-muted-foreground">
                  +{count - 2} more
                </span>
              )}
            </div>
          )
        },
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: 'Created',
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')
          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
    ],
    [columnHelper]
  )

  const vpaSearchFilter = useCallback(
    (vpa: VerticalPodAutoscaler, query: string) => {
      const queryLower = query.toLowerCase()
      return (
        vpa.metadata!.name!.toLowerCase().includes(queryLower) ||
        (vpa.metadata!.namespace?.toLowerCase() || '').includes(queryLower) ||
        getVpaTargetInfo(vpa).toLowerCase().includes(queryLower)
      )
    },
    []
  )

  return (
    <ResourceTable
      resourceName="VerticalPodAutoscalers"
      resourceType={'verticalpodautoscalers.autoscaling.k8s.io' as any}
      columns={columns}
      searchQueryFilter={vpaSearchFilter}
    />
  )
}

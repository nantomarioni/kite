import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppView } from '@/lib/appview-api'
import { useResources } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    IconLoader,
    IconSearch,
    IconAdjustmentsHorizontal,
    IconArrowRight,
    IconBox,
    IconRocket,
    IconNetwork,
    IconRouter,
} from '@tabler/icons-react'
import { Link } from 'react-router-dom'
import { getPodStatus, getDeploymentStatus } from '@/lib/k8s'
import { PodStatusIcon } from '@/components/pod-status-icon'
import { DeploymentStatusIcon } from '@/components/deployment-status-icon'

export default function AppView() {
    const { t } = useTranslation()
    const [namespace, setNamespace] = useState<string>('default')
    const [labelSelector, setLabelSelector] = useState<string>('')

    const { data: namespaces, isLoading: isLoadingNamespaces } = useResources(
        'namespaces',
        undefined
    )

    const {
        data: appData,
        isLoading,
        isRefetching,
        refetch,
    } = useAppView(namespace, labelSelector)

    const handleSearch = () => {
        refetch()
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row gap-4 items-end">
                <div className="w-full md:w-64 space-y-2">
                    <label className="text-sm font-medium">{t('common.namespace')}</label>
                    <Select value={namespace} onValueChange={setNamespace}>
                        <SelectTrigger>
                            <SelectValue placeholder="Select namespace" />
                        </SelectTrigger>
                        <SelectContent>
                            {isLoadingNamespaces ? (
                                <SelectItem value="loading" disabled>
                                    Loading...
                                </SelectItem>
                            ) : (
                                namespaces?.map((ns) => (
                                    <SelectItem key={ns.metadata?.name} value={ns.metadata?.name!}>
                                        {ns.metadata?.name}
                                    </SelectItem>
                                ))
                            )}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex-1 space-y-2">
                    <label className="text-sm font-medium">Label Selector (e.g. app=nginx)</label>
                    <div className="relative">
                        <IconAdjustmentsHorizontal className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            value={labelSelector}
                            onChange={(e) => setLabelSelector(e.target.value)}
                            className="pl-9"
                            placeholder="Filter by labels..."
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        />
                    </div>
                </div>

                <Button onClick={handleSearch} disabled={isLoading || isRefetching}>
                    {isLoading || isRefetching ? (
                        <IconLoader className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                        <IconSearch className="w-4 h-4 mr-2" />
                    )}
                    {t('common.search')}
                </Button>
            </div>

            {isLoading && !appData ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                    <IconLoader className="w-10 h-10 animate-spin text-primary" />
                    <p className="text-muted-foreground">Fetching application resources...</p>
                </div>
            ) : (
                <div className="space-y-8">
                    {/* Ingresses */}
                    {appData?.ingresses && appData.ingresses.length > 0 && (
                        <section className="space-y-4">
                            <h3 className="text-lg font-semibold flex items-center gap-2">
                                <IconRouter className="text-blue-500" />
                                Ingresses
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {appData.ingresses.map((ing) => (
                                    <Card key={ing.metadata?.uid} className="hover:shadow-md transition-shadow">
                                        <CardHeader className="py-3 px-4 bg-muted/30">
                                            <CardTitle className="text-sm font-medium truncate">
                                                <Link
                                                    to={`/ingresses/${ing.metadata?.namespace}/${ing.metadata?.name}`}
                                                    className="text-blue-500 hover:underline"
                                                >
                                                    {ing.metadata?.name}
                                                </Link>
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="py-3 px-4">
                                            {ing.spec?.rules?.map((rule, i) => (
                                                <div key={i} className="text-xs space-y-1">
                                                    <p className="font-mono text-muted-foreground">{rule.host}</p>
                                                    {rule.http?.paths.map((path, j) => (
                                                        <div key={j} className="flex items-center gap-2 ml-2">
                                                            <span className="text-muted-foreground">{path.path}</span>
                                                            <IconArrowRight className="w-3 h-3 text-muted-foreground" />
                                                            <Badge variant="outline">{path.backend.service?.name}</Badge>
                                                        </div>
                                                    ))}
                                                </div>
                                            ))}
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Services */}
                    {appData?.services && appData.services.length > 0 && (
                        <section className="space-y-4">
                            <h3 className="text-lg font-semibold flex items-center gap-2">
                                <IconNetwork className="text-green-500" />
                                Services
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {appData.services.map((svc) => (
                                    <Card key={svc.metadata?.uid} className="hover:shadow-md transition-shadow border-l-4 border-l-green-500">
                                        <CardHeader className="py-3 px-4">
                                            <CardTitle className="text-sm font-medium truncate">
                                                <Link
                                                    to={`/services/${svc.metadata?.namespace}/${svc.metadata?.name}`}
                                                    className="text-blue-500 hover:underline"
                                                >
                                                    {svc.metadata?.name}
                                                </Link>
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="py-2 px-4 space-y-2">
                                            <div className="flex justify-between items-center text-xs">
                                                <span className="text-muted-foreground">Type:</span>
                                                <Badge variant="secondary">{svc.spec?.type}</Badge>
                                            </div>
                                            <div className="flex justify-between items-center text-xs">
                                                <span className="text-muted-foreground">Cluster IP:</span>
                                                <span className="font-mono">{svc.spec?.clusterIP}</span>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Workloads (Deployments & StatefulSets) */}
                    <section className="space-y-4">
                        <h3 className="text-lg font-semibold flex items-center gap-2">
                            <IconRocket className="text-orange-500" />
                            Workloads
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* Deployments */}
                            {appData?.deployments.map((dep) => (
                                <Card key={dep.metadata?.uid} className="overflow-hidden">
                                    <div className="bg-orange-500/10 px-4 py-2 border-b flex justify-between items-center">
                                        <span className="text-xs font-bold uppercase tracking-wider text-orange-600">Deployment</span>
                                        <Badge variant="outline" className="text-[10px] space-x-1">
                                            <DeploymentStatusIcon status={getDeploymentStatus(dep)} />
                                            <span>{getDeploymentStatus(dep)}</span>
                                        </Badge>
                                    </div>
                                    <CardHeader className="py-3 px-4">
                                        <CardTitle className="text-md truncate">
                                            <Link
                                                to={`/deployments/${dep.metadata?.namespace}/${dep.metadata?.name}`}
                                                className="text-blue-500 hover:underline"
                                            >
                                                {dep.metadata?.name}
                                            </Link>
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="py-3 px-4">
                                        <div className="flex items-center gap-4 text-sm mb-4">
                                            <div>
                                                <p className="text-xs text-muted-foreground">Ready</p>
                                                <p className="font-bold">{dep.status?.readyReplicas || 0} / {dep.spec?.replicas || 0}</p>
                                            </div>
                                            <Separator orientation="vertical" className="h-8" />
                                            <div>
                                                <p className="text-xs text-muted-foreground">Updated</p>
                                                <p className="font-bold">{dep.status?.updatedReplicas || 0}</p>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}

                            {/* StatefulSets */}
                            {appData?.statefulSets.map((sts) => (
                                <Card key={sts.metadata?.uid} className="overflow-hidden">
                                    <div className="bg-purple-500/10 px-4 py-2 border-b flex justify-between items-center">
                                        <span className="text-xs font-bold uppercase tracking-wider text-purple-600">StatefulSet</span>
                                        <Badge variant="outline" className="text-[10px]">
                                            {sts.status?.readyReplicas || 0} / {sts.spec?.replicas || 0}
                                        </Badge>
                                    </div>
                                    <CardHeader className="py-3 px-4">
                                        <CardTitle className="text-md truncate">
                                            <Link
                                                to={`/statefulsets/${sts.metadata?.namespace}/${sts.metadata?.name}`}
                                                className="text-blue-500 hover:underline"
                                            >
                                                {sts.metadata?.name}
                                            </Link>
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="py-3 px-4">
                                        <p className="text-sm text-muted-foreground italic truncate">
                                            {sts.spec?.serviceName && `Service: ${sts.spec.serviceName}`}
                                        </p>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </section>

                    {/* Pods */}
                    <section className="space-y-4">
                        <h3 className="text-lg font-semibold flex items-center gap-2">
                            <IconBox className="text-pink-500" />
                            Pods
                        </h3>
                        <div className="flex flex-wrap gap-3">
                            {appData?.pods.map((pod) => {
                                const status = getPodStatus(pod)
                                return (
                                    <Link
                                        key={pod.metadata?.uid}
                                        to={`/pods/${pod.metadata?.namespace}/${pod.metadata?.name}`}
                                        className="block"
                                    >
                                        <div className="p-3 bg-card border rounded-lg hover:border-primary/50 transition-colors flex items-center gap-3 min-w-[200px] shadow-sm">
                                            <PodStatusIcon status={status.reason!} />
                                            <div className="flex flex-col min-w-0">
                                                <span className="text-sm font-medium truncate max-w-[150px]">{pod.metadata?.name}</span>
                                                <span className="text-[10px] text-muted-foreground">{status.readyContainers}/{status.totalContainers} Ready</span>
                                            </div>
                                        </div>
                                    </Link>
                                )
                            })}
                        </div>
                    </section>

                    {/* Configs & Storage */}
                    <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <Card className="bg-muted/10">
                            <CardHeader className="py-3 px-4 border-b">
                                <CardTitle className="text-xs font-bold uppercase tracking-widest text-muted-foreground">ConfigMaps</CardTitle>
                            </CardHeader>
                            <CardContent className="py-2 px-4">
                                <ul className="text-xs space-y-1">
                                    {appData?.configMaps.map(cm => (
                                        <li key={cm.metadata?.uid} className="truncate">
                                            <Link to={`/configmaps/${cm.metadata?.namespace}/${cm.metadata?.name}`} className="hover:underline text-muted-foreground hover:text-foreground">
                                                {cm.metadata?.name}
                                            </Link>
                                        </li>
                                    ))}
                                    {appData?.configMaps.length === 0 && <span className="text-muted-foreground italic">None</span>}
                                </ul>
                            </CardContent>
                        </Card>

                        <Card className="bg-muted/10">
                            <CardHeader className="py-3 px-4 border-b">
                                <CardTitle className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Secrets</CardTitle>
                            </CardHeader>
                            <CardContent className="py-2 px-4">
                                <ul className="text-xs space-y-1">
                                    {appData?.secrets.map(s => (
                                        <li key={s.metadata?.uid} className="truncate">
                                            <Link to={`/secrets/${s.metadata?.namespace}/${s.metadata?.name}`} className="hover:underline text-muted-foreground hover:text-foreground">
                                                {s.metadata?.name}
                                            </Link>
                                        </li>
                                    ))}
                                    {appData?.secrets.length === 0 && <span className="text-muted-foreground italic">None</span>}
                                </ul>
                            </CardContent>
                        </Card>

                        <Card className="bg-muted/10">
                            <CardHeader className="py-3 px-4 border-b">
                                <CardTitle className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Volumes (PVCs)</CardTitle>
                            </CardHeader>
                            <CardContent className="py-2 px-4">
                                <ul className="text-xs space-y-1">
                                    {appData?.pvcs.map(pvc => (
                                        <li key={pvc.metadata?.uid} className="truncate">
                                            <Link to={`/persistentvolumeclaims/${pvc.metadata?.namespace}/${pvc.metadata?.name}`} className="hover:underline text-muted-foreground hover:text-foreground">
                                                {pvc.metadata?.name}
                                            </Link>
                                            <span className="ml-2 text-[10px] text-muted-foreground">({pvc.status?.phase})</span>
                                        </li>
                                    ))}
                                    {appData?.pvcs.length === 0 && <span className="text-muted-foreground italic">None</span>}
                                </ul>
                            </CardContent>
                        </Card>
                    </section>
                </div>
            )}
        </div>
    )
}

function Separator({ orientation, className }: { orientation: 'horizontal' | 'vertical'; className?: string }) {
    return (
        <div
            className={`bg-border ${orientation === 'horizontal' ? 'h-[1px] w-full' : 'w-[1px] h-full'} ${className}`}
        />
    )
}

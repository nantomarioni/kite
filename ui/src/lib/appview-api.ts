import { useQuery } from '@tanstack/react-query'
import { AppViewResponse } from '@/types/api'
import { apiClient } from './api-client'

export const fetchAppView = async (namespace: string, labelSelector: string): Promise<AppViewResponse> => {
    const params = new URLSearchParams({ namespace })
    if (labelSelector) {
        params.append('labelSelector', labelSelector)
    }
    return await apiClient.get<AppViewResponse>(`/app-view?${params.toString()}`)
}

export const useAppView = (namespace: string, labelSelector: string, options?: { refreshInterval?: number }) => {
    return useQuery({
        queryKey: ['app-view', namespace, labelSelector],
        queryFn: () => fetchAppView(namespace, labelSelector),
        enabled: !!namespace,
        refetchInterval: options?.refreshInterval || 0,
        staleTime: 5000,
    })
}

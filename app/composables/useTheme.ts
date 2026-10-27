import { usePreferredDark } from '@vueuse/core'
import { computed, type ComputedRef } from 'vue'
import { useSettings } from './useApp'

export type ResolvedTheme = 'dark' | 'light'

/** The theme in effect: the user's choice, or the OS preference when set to 'system'. */
export function useTheme(): ComputedRef<ResolvedTheme> {
  const settings = useSettings()
  const prefersDark = usePreferredDark()

  return computed(() =>
    settings.theme === 'system' ? (prefersDark.value ? 'dark' : 'light') : settings.theme,
  )
}

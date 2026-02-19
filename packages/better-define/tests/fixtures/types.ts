export type Num = number

export interface CommonProps {
  base: string
}

export interface UtilityBase {
  id: string
  name: string
  internalOnly: boolean
}

export interface UtilityExtra {
  mode: 'light' | 'dark'
  count?: number
}

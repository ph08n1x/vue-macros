<script setup lang="ts">
import type { UtilityBase, UtilityExtra } from './types'

type Picked = Pick<UtilityBase, 'id' | 'name'>
type Omitted = Omit<UtilityExtra, 'count'>

defineProps<Picked & Omitted>()
</script>

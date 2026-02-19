<script setup lang="ts">
import type { UtilityBase, UtilityExtra } from '@/types'

type Props = Pick<UtilityBase, 'id' | 'name'> & Omit<UtilityExtra, 'count'>
defineProps<Props>()
</script>

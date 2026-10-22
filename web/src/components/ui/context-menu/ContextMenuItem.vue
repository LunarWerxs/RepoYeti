<script lang="ts">
import { ContextMenuItem } from "reka-ui"
import * as skin from "@ui-skin/context-menu"
import { defineMenuItem } from "../core/forward-part"

export default defineMenuItem(ContextMenuItem, "context-menu-item", "group/context-menu-item", skin.item)
</script>

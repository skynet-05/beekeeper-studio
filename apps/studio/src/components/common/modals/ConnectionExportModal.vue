<template>
  <base-modal
    name="export-saved-connections"
    class="export-saved-connections-modal"
    :loading="loading"
    @submit="submit"
  >
    <template #title>
      Export Connections
    </template>
    <error-alert :error="error" />
    <p class="hint">
      Passwords are included. Set a passphrase to encrypt the file.
    </p>
    <div
      v-if="!loading && rows.length === 0"
      class="empty"
    >
      No saved connections.
    </div>
    <ul
      v-else
      class="connection-list"
    >
      <li
        v-for="row in rows"
        :key="row.id"
      >
        <label>
          <input
            type="checkbox"
            :checked="selectedIds.includes(row.id)"
            @change="toggle(row.id)"
          >
          <span>{{ row.name }}</span>
          <span class="connection-type">{{ row.connectionType }}</span>
        </label>
      </li>
    </ul>
    <div class="form-group">
      <label for="export-passphrase">Passphrase</label>
      <input
        id="export-passphrase"
        v-model="passphrase"
        class="form-control"
        type="password"
        autocomplete="off"
      >
    </div>
    <div class="form-group">
      <label for="export-passphrase-confirm">Confirm passphrase</label>
      <input
        id="export-passphrase-confirm"
        v-model="confirmPassphrase"
        class="form-control"
        type="password"
        autocomplete="off"
      >
      <div
        v-if="passphraseMismatch"
        class="alert text-danger passphrase-mismatch"
      >
        Passphrases do not match.
      </div>
    </div>
    <template #footer="{ close }">
      <button
        class="btn btn-flat"
        type="button"
        @click="close"
      >
        Cancel
      </button>
      <button
        class="btn btn-primary"
        type="submit"
        data-testid="export-saved-connections"
        :disabled="!canExport || loading"
      >
        Export
      </button>
    </template>
  </base-modal>
</template>

<script lang="ts">
import Vue from 'vue'
import { AppEvent } from '@/common/AppEvent'
import ErrorAlert from '@/components/common/ErrorAlert.vue'
import BaseModal from '@/components/common/modals/BaseModal.vue'
import { canExportConnections, formatExportNotice } from '@/lib/connectionTransfer'

interface LocalConnectionSummary {
  id: number
  name: string
  connectionType: string | null
}

export default Vue.extend({
  components: { ErrorAlert, BaseModal },
  data() {
    return {
      loading: false,
      error: null as Error | null,
      rows: [] as LocalConnectionSummary[],
      selectedIds: [] as number[],
      passphrase: '',
      confirmPassphrase: '',
      loadToken: 0,
    }
  },
  computed: {
    rootBindings() {
      return [{ event: AppEvent.promptConnectionExport, handler: this.open }]
    },
    canExport(): boolean {
      return canExportConnections(this.selectedIds.length, this.passphrase, this.confirmPassphrase)
    },
    passphraseMismatch(): boolean {
      return (this.passphrase !== '' || this.confirmPassphrase !== '') && this.passphrase !== this.confirmPassphrase
    },
  },
  mounted() {
    this.registerHandlers(this.rootBindings)
  },
  beforeDestroy() {
    this.unregisterHandlers(this.rootBindings)
  },
  methods: {
    reset() {
      this.loading = false
      this.error = null
      this.rows = []
      this.selectedIds = []
      this.passphrase = ''
      this.confirmPassphrase = ''
    },
    async open() {
      const token = ++this.loadToken
      this.reset()
      this.loading = true
      this.$modal.show('export-saved-connections')
      try {
        const rows = await this.$util.send('connectionTransfer/listLocal')
        if (token !== this.loadToken) return
        this.rows = rows
        this.selectedIds = rows.map((row: LocalConnectionSummary) => row.id)
      } catch (error) {
        if (token !== this.loadToken) return
        this.error = error
      } finally {
        if (token === this.loadToken) this.loading = false
      }
    },
    toggle(id: number) {
      if (this.selectedIds.includes(id)) {
        this.selectedIds = this.selectedIds.filter((selected) => selected !== id)
      } else {
        this.selectedIds = this.selectedIds.concat(id)
      }
    },
    async submit() {
      if (!this.canExport || this.loading) return
      const token = this.loadToken
      const picked = this.$native.dialog.showSaveDialogSync({
        defaultPath: 'beekeeper-connections.json',
        filters: [
          { name: 'Connection files (*.json)', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      }) as string | undefined
      if (!picked) return
      this.loading = true
      this.error = null
      try {
        const result = await this.$util.send('connectionTransfer/export', {
          ids: this.selectedIds.slice(),
          filePath: picked,
          passphrase: this.passphrase,
        })
        this.$noty.success(formatExportNotice(result.count), { timeout: false, progressBar: false })
        if (token !== this.loadToken) return
        this.$modal.hide('export-saved-connections')
      } catch (error) {
        if (token !== this.loadToken) return
        this.error = error
      } finally {
        if (token === this.loadToken) this.loading = false
      }
    },
  },
})
</script>

<style lang="scss" scoped>
.hint {
  color: var(--text-muted);
  margin-top: 0;
}

.connection-list {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
  max-height: 40vh;
  overflow-y: auto;

  li {
    line-height: 1.6;
  }

  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
}

.connection-type {
  color: var(--text-muted);
}

.passphrase-mismatch {
  margin-top: 0.5rem;
  margin-bottom: 0;
}

.empty {
  margin-bottom: 1rem;
}
</style>

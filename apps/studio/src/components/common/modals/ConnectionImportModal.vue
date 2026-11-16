<template>
  <base-modal
    name="import-saved-connections"
    class="import-saved-connections-modal"
    :loading="loading"
    @submit="submit"
  >
    <template #title>
      Import Connections
    </template>
    <error-alert :error="error" />

    <div v-if="step === 'choose'">
      <div class="form-group">
        <label for="import-mode">Mode</label>
        <select
          id="import-mode"
          v-model="mode"
          class="form-control custom-select"
        >
          <option value="add">
            Add
          </option>
          <option value="replace">
            Replace all
          </option>
        </select>
      </div>
      <div class="form-group">
        <label for="import-file">File</label>
        <file-picker
          v-model="filePath"
          input-id="import-file"
          button-text="Choose File"
          :options="dialogOptions"
        />
      </div>
      <div
        v-if="encrypted"
        class="form-group"
      >
        <label for="import-passphrase">Passphrase</label>
        <input
          id="import-passphrase"
          v-model="passphrase"
          class="form-control"
          type="password"
          autocomplete="off"
        >
      </div>
    </div>

    <div v-else-if="step === 'conflicts'">
      <p>These connections already exist.</p>
      <ul class="conflict-list">
        <li
          v-for="row in conflictRows"
          :key="row.index"
        >
          <div class="conflict-name">
            {{ row.name }}
          </div>
          <div class="conflict-matches">
            Matches {{ row.matches.join(', ') }}
          </div>
          <label>
            <input
              type="radio"
              value="import"
              v-model="choices[row.index]"
            >
            Import
          </label>
          <label>
            <input
              type="radio"
              value="skip"
              v-model="choices[row.index]"
            >
            Skip
          </label>
        </li>
      </ul>
    </div>

    <div v-else-if="step === 'replace'">
      <p>{{ deletedMessage }}</p>
    </div>

    <div v-else-if="step === 'summary'">
      <p>{{ countsLine }}</p>
      <div v-if="summary && summary.skippedNames.length">
        <p>Skipped</p>
        <ul>
          <li
            v-for="(name, index) in summary.skippedNames"
            :key="'skipped-' + index"
          >
            {{ name }}
          </li>
        </ul>
      </div>
      <div v-if="summary && summary.missingKeyNames.length">
        <p>Key or cert file not found.</p>
        <ul>
          <li
            v-for="(name, index) in summary.missingKeyNames"
            :key="'missing-' + index"
          >
            {{ name }}
          </li>
        </ul>
      </div>
    </div>

    <template #footer="{ close }">
      <button
        class="btn btn-flat"
        type="button"
        @click="close"
      >
        {{ step === 'summary' ? 'Close' : 'Cancel' }}
      </button>
      <button
        v-if="step !== 'summary'"
        class="btn btn-primary"
        type="submit"
        data-testid="import-saved-connections"
        :disabled="submitDisabled"
      >
        {{ submitLabel }}
      </button>
    </template>
  </base-modal>
</template>

<script lang="ts">
import Vue from 'vue'
import { AppEvent } from '@/common/AppEvent'
import ErrorAlert from '@/components/common/ErrorAlert.vue'
import BaseModal from '@/components/common/modals/BaseModal.vue'
import FilePicker from '@/components/common/form/FilePicker.vue'
import {
  ImportResult,
  ImportRow,
  NOT_CONNECTION_FILE_MESSAGE,
  UNSUPPORTED_VERSION_MESSAGE,
  WRONG_PASSPHRASE_MESSAGE,
  formatDeletedCount,
  formatImportCounts,
} from '@/lib/connectionTransfer'

type Step = 'choose' | 'conflicts' | 'replace' | 'summary'
type Choice = 'import' | 'skip'

interface InspectResult {
  needsPassphrase: boolean
  encrypted: boolean
  rows: ImportRow[]
  localCount: number
}

const REJECTED_MESSAGES = [NOT_CONNECTION_FILE_MESSAGE, UNSUPPORTED_VERSION_MESSAGE]

export default Vue.extend({
  components: { ErrorAlert, BaseModal, FilePicker },
  data() {
    return {
      loading: false,
      error: null as Error | null,
      rejected: false,
      step: 'choose' as Step,
      mode: 'add' as 'add' | 'replace',
      filePath: '',
      encrypted: false,
      passphrase: '',
      rows: [] as ImportRow[],
      localCount: 0,
      choices: {} as Record<number, Choice>,
      summary: null as ImportResult | null,
      fileToken: 0,
      opToken: 0,
    }
  },
  computed: {
    rootBindings() {
      return [{ event: AppEvent.promptConnectionFilesImport, handler: this.open }]
    },
    dialogOptions() {
      return {
        filters: [
          { name: 'Connection files (*.json)', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      }
    },
    conflictRows(): ImportRow[] {
      return this.rows.filter((row) => row.conflict && !row.broken)
    },
    deletedMessage(): string {
      return formatDeletedCount(this.localCount)
    },
    countsLine(): string {
      return this.summary ? formatImportCounts(this.summary) : ''
    },
    submitLabel(): string {
      if (this.step === 'replace') return 'Delete and import'
      return 'Import'
    },
    submitDisabled(): boolean {
      if (this.loading) return true
      if (this.step === 'choose') return !this.filePath || this.rejected
      return false
    },
  },
  watch: {
    filePath(path: string) {
      this.onFilePicked(path)
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
      this.opToken += 1
      this.fileToken += 1
      this.loading = false
      this.error = null
      this.rejected = false
      this.step = 'choose'
      this.mode = 'add'
      this.filePath = ''
      this.encrypted = false
      this.passphrase = ''
      this.rows = []
      this.localCount = 0
      this.choices = {}
      this.summary = null
    },
    open() {
      this.reset()
      this.$modal.show('import-saved-connections')
    },
    async onFilePicked(path: string) {
      const token = ++this.fileToken
      this.encrypted = false
      this.passphrase = ''
      this.error = null
      this.rejected = false
      this.rows = []
      if (!path) return
      this.loading = true
      try {
        const result: InspectResult = await this.$util.send('connectionTransfer/inspect', { filePath: path })
        if (token !== this.fileToken) return
        this.encrypted = result.needsPassphrase
        if (!result.needsPassphrase) {
          this.rows = result.rows
          this.localCount = result.localCount
        }
      } catch (error) {
        if (token !== this.fileToken) return
        this.error = error
        this.rejected = REJECTED_MESSAGES.includes(error?.message)
      } finally {
        if (token === this.fileToken) this.loading = false
      }
    },
    async submit() {
      if (this.submitDisabled || this.step === 'summary') return
      if (this.step === 'choose') return this.submitChoose()
      if (this.step === 'conflicts') return this.applyChosen()
      if (this.step === 'replace') return this.applyChosen()
    },
    async submitChoose() {
      const token = this.opToken
      this.loading = true
      this.error = null
      try {
        const result: InspectResult = await this.$util.send('connectionTransfer/inspect', {
          filePath: this.filePath,
          passphrase: this.encrypted ? this.passphrase : '',
        })
        if (token !== this.opToken) return
        if (result.needsPassphrase) {
          this.encrypted = true
          this.error = new Error(WRONG_PASSPHRASE_MESSAGE)
          return
        }
        this.rows = result.rows
        this.localCount = result.localCount
        if (this.mode === 'replace') {
          this.step = 'replace'
          return
        }
        const conflicts = result.rows.filter((row) => row.conflict && !row.broken)
        if (conflicts.length === 0) {
          await this.applyChosen()
          return
        }
        const choices: Record<number, Choice> = {}
        conflicts.forEach((row) => {
          choices[row.index] = 'skip'
        })
        this.choices = choices
        this.step = 'conflicts'
      } catch (error: any) {
        if (token !== this.opToken) return
        this.error = error
        this.rejected = REJECTED_MESSAGES.includes(error?.message)
      } finally {
        if (token === this.opToken) this.loading = false
      }
    },
    async applyChosen() {
      const token = this.opToken
      this.loading = true
      this.error = null
      try {
        const importIndexes = this.rows
          .filter((row) => row.conflict && this.choices[row.index] === 'import')
          .map((row) => row.index)
        const summary: ImportResult = await this.$util.send('connectionTransfer/apply', {
          filePath: this.filePath,
          passphrase: this.encrypted ? this.passphrase : '',
          mode: this.mode,
          importIndexes,
        })
        await this.$store.dispatch('refreshConnections')
        if (token !== this.opToken) return
        this.summary = summary
        this.step = 'summary'
      } catch (error) {
        if (token !== this.opToken) return
        this.error = error
      } finally {
        if (token === this.opToken) this.loading = false
      }
    },
  },
})
</script>

<style lang="scss" scoped>
.conflict-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 40vh;
  overflow-y: auto;

  li {
    margin-bottom: 0.75rem;
  }

  label {
    margin-right: 1rem;
  }
}

.conflict-matches {
  color: var(--text-muted);
}
</style>

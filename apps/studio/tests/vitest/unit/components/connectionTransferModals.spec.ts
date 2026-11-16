import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Vue from 'vue'
import ConnectionExportModal from '@/components/common/modals/ConnectionExportModal.vue'
import ConnectionImportModal from '@/components/common/modals/ConnectionImportModal.vue'

const handlersMixin = {
  methods: {
    registerHandlers: vi.fn(),
    unregisterHandlers: vi.fn(),
  },
}

const BaseModalStub = {
  template: '<form @submit.prevent="$emit(\'submit\')"><slot /><slot name="footer" :close="close" /></form>',
  methods: {
    close() { this.$emit('closed') },
  },
}

async function settle(wrapper) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Vue.nextTick()
    if (!wrapper.vm.loading) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function mountExport(options: { savePath?: string | undefined, send?: ReturnType<typeof vi.fn> } = {}) {
  const send = options.send ?? vi.fn().mockResolvedValue({ count: 2 })
  const noty = { success: vi.fn(), error: vi.fn() }
  const modal = { show: vi.fn(), hide: vi.fn() }
  const wrapper = mount(ConnectionExportModal, {
    mixins: [handlersMixin],
    stubs: { BaseModal: BaseModalStub, ErrorAlert: true },
    mocks: {
      $modal: modal,
      $noty: noty,
      $util: { send },
      $native: {
        dialog: {
          showSaveDialogSync: vi.fn(() => options.savePath),
        },
      },
    },
  })
  return { wrapper, send, noty, modal }
}

describe('ConnectionExportModal', () => {
  it('checks every local connection when the export screen opens', async () => {
    const send = vi.fn().mockResolvedValue([
      { id: 1, name: 'Alpha', connectionType: 'postgresql' },
      { id: 2, name: 'Beta', connectionType: 'sqlite' },
    ])
    const { wrapper } = mountExport({ send })

    await wrapper.vm.open()

    expect(wrapper.vm.selectedIds).toEqual([1, 2])
    expect(wrapper.find('[data-testid=export-saved-connections]').attributes('disabled')).toBeUndefined()
    wrapper.destroy()
  })

  it('starts ready to export every connection and disables export when none are checked', async () => {
    const { wrapper } = mountExport()
    await wrapper.setData({
      rows: [
        { id: 1, name: 'Alpha', connectionType: 'postgresql' },
        { id: 2, name: 'Beta', connectionType: 'sqlite' },
      ],
      selectedIds: [1, 2],
    })

    const button = wrapper.find('[data-testid=export-saved-connections]')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('Passwords are included. Set a passphrase to encrypt the file.')

    await wrapper.setData({ selectedIds: [] })
    expect(button.attributes('disabled')).toBe('disabled')
    wrapper.destroy()
  })

  it('disables export until the passphrases match', async () => {
    const { wrapper } = mountExport()
    await wrapper.setData({
      rows: [{ id: 1, name: 'Alpha', connectionType: 'postgresql' }],
      selectedIds: [1],
      passphrase: 'secret',
      confirmPassphrase: 'other',
    })

    expect(wrapper.find('[data-testid=export-saved-connections]').attributes('disabled')).toBe('disabled')
    expect(wrapper.text()).toContain('Passphrases do not match.')

    await wrapper.setData({ confirmPassphrase: 'secret' })
    expect(wrapper.find('[data-testid=export-saved-connections]').attributes('disabled')).toBeUndefined()
    wrapper.destroy()
  })

  it('does nothing and shows no error when the save dialog is canceled', async () => {
    const { wrapper, send } = mountExport({ savePath: undefined })
    await wrapper.setData({
      rows: [{ id: 1, name: 'Alpha', connectionType: 'postgresql' }],
      selectedIds: [1],
    })

    await wrapper.vm.submit()

    expect(send).not.toHaveBeenCalled()
    expect(wrapper.vm.error).toBeNull()
    wrapper.destroy()
  })

  it('closes after a successful export and leaves the notice up', async () => {
    const { wrapper, send, noty, modal } = mountExport({ savePath: '/tmp/beekeeper-connections.json' })
    await wrapper.setData({
      rows: [
        { id: 1, name: 'Alpha', connectionType: 'postgresql' },
        { id: 2, name: 'Beta', connectionType: 'sqlite' },
      ],
      selectedIds: [1, 2],
      passphrase: '',
      confirmPassphrase: '',
    })

    await wrapper.vm.submit()

    expect(send).toHaveBeenCalledWith('connectionTransfer/export', {
      ids: [1, 2],
      filePath: '/tmp/beekeeper-connections.json',
      passphrase: '',
    })
    expect(modal.hide).toHaveBeenCalledWith('export-saved-connections')
    expect(noty.success).toHaveBeenCalledWith('Exported 2 connections', { timeout: false, progressBar: false })
    wrapper.destroy()
  })
})

describe('ConnectionImportModal', () => {
  function mountImport(send: ReturnType<typeof vi.fn>) {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const wrapper = mount(ConnectionImportModal, {
      mixins: [handlersMixin],
      stubs: {
        BaseModal: BaseModalStub,
        ErrorAlert: true,
        FilePicker: true,
      },
      mocks: {
        $modal: { show: vi.fn(), hide: vi.fn() },
        $store: { dispatch },
        $util: { send },
      },
    })
    return { wrapper, dispatch }
  }

  it('writes immediately when add has no conflicts', async () => {
    const send = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'connectionTransfer/inspect') {
        return {
          needsPassphrase: false,
          encrypted: false,
          localCount: 0,
          rows: [{ index: 0, name: 'Alpha', broken: false, conflict: false, matches: [] }],
        }
      }
      return { imported: 1, skipped: 0, alreadyExists: 0, skippedNames: [], missingKeyNames: [] }
    })
    const { wrapper, dispatch } = mountImport(send)
    await wrapper.setData({ filePath: '/tmp/connections.json', encrypted: false })
    await settle(wrapper)

    await wrapper.vm.submit()

    expect(send).toHaveBeenCalledWith('connectionTransfer/apply', expect.objectContaining({
      filePath: '/tmp/connections.json',
      mode: 'add',
      importIndexes: [],
    }))
    expect(dispatch).toHaveBeenCalledWith('refreshConnections')
    expect(wrapper.vm.step).toBe('summary')
    expect(wrapper.text()).toContain('Imported 1, skipped 0, already exists 0.')
    wrapper.destroy()
  })

  it('asks again after a wrong passphrase and does not import', async () => {
    const send = vi.fn().mockImplementation(async (name: string, args: { passphrase?: string }) => {
      if (name !== 'connectionTransfer/inspect') throw new Error('unexpected')
      if (!args?.passphrase) return { needsPassphrase: true, encrypted: true, rows: [], localCount: 0 }
      throw new Error('Wrong passphrase.')
    })
    const { wrapper } = mountImport(send)
    await wrapper.setData({ filePath: '/tmp/connections.json' })
    await settle(wrapper)
    await wrapper.setData({ encrypted: true, passphrase: 'nope' })

    await wrapper.vm.submit()

    expect(send).not.toHaveBeenCalledWith('connectionTransfer/apply', expect.anything())
    expect(wrapper.vm.step).toBe('choose')
    expect(wrapper.find('#import-passphrase').exists()).toBe(true)
    expect(wrapper.vm.error.message).toBe('Wrong passphrase.')
    expect(wrapper.find('[data-testid=import-saved-connections]').attributes('disabled')).toBeUndefined()
    wrapper.destroy()
  })

  it('leaves saved connections unwritten when replace is not confirmed', async () => {
    const send = vi.fn().mockResolvedValue({
      needsPassphrase: false,
      encrypted: false,
      localCount: 4,
      rows: [{ index: 0, name: 'Alpha', broken: false, conflict: false, matches: [] }],
    })
    const { wrapper } = mountImport(send)
    await wrapper.setData({ filePath: '/tmp/connections.json', mode: 'replace' })
    await settle(wrapper)

    await wrapper.vm.submit()

    expect(wrapper.vm.step).toBe('replace')
    expect(wrapper.text()).toContain('4 saved connections will be deleted.')
    expect(send).not.toHaveBeenCalledWith('connectionTransfer/apply', expect.anything())
    wrapper.destroy()
  })
})

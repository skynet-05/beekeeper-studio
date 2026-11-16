export const NOT_CONNECTION_FILE_MESSAGE = 'File is not connection JSON.'
export const WRONG_PASSPHRASE_MESSAGE = 'Wrong passphrase.'
export const UNSUPPORTED_VERSION_MESSAGE = 'Unsupported connection file version.'

export class NotConnectionFileError extends Error {
  constructor() {
    super(NOT_CONNECTION_FILE_MESSAGE)
    this.name = 'NotConnectionFileError'
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super(WRONG_PASSPHRASE_MESSAGE)
    this.name = 'WrongPassphraseError'
  }
}

export class UnsupportedVersionError extends Error {
  constructor() {
    super(UNSUPPORTED_VERSION_MESSAGE)
    this.name = 'UnsupportedVersionError'
  }
}

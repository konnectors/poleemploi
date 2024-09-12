/* eslint-disable no-console */
import {
  ContentScript,
  RequestInterceptor
} from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('poleemploiCCC')

// Necessary here because they are using this function and the are not supported by the webview
console.group = function () {}
console.groupCollapsed = function () {}
console.groupEnd = function () {}

const requestInterceptor = new RequestInterceptor([
  {
    identifier: 'userCivilState',
    method: 'GET',
    url: '/moyenscontactindividu/etatcivil',
    serialization: 'json'
  }
])
requestInterceptor.init()

const baseUrl = 'https://www.francetravail.fr/accueil/'
const loginFormUrl = 'https://candidat.francetravail.fr/espacepersonnel/'

class PoleemploiContentScript extends ContentScript {
  async onWorkerReady() {
    await this.waitForElementNoReload.bind(this)('#password')
    const submitButton = document.querySelector('#submit')
    // Using classic event won't work properly, as all events only return "isTrusted" value
    // When submitting the form, the submit button mutate to disable himself and adds a spinner while waiting for the server response
    // Using this we ensure the user actually submit the loginForm
    if (MutationObserver) {
      const observer = new MutationObserver(mutationsList => {
        for (const mutation of mutationsList) {
          if (
            mutation.type === 'attributes' &&
            mutation.attributeName === 'disabled'
          ) {
            if (submitButton.disabled) {
              this.log('debug', 'Submit detected, emitting credentials')
              this.emitCredentials.bind(this)()
            }
          }
        }
      })
      observer.observe(submitButton, { attributes: true })
    }
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', `User's credential intercepted`)
      const { login, password } = payload
      this.store.userCredentials = { login, password }
    }
    if (event === 'requestResponse') {
      const { identifier, response } = payload
      this.log('debug', `${identifier} request intercepted`)
      this.store[identifier] = { response }
    }
  }

  emitCredentials() {
    this.log('info', '📍️ emitCredentials starts')
    const loginField = document.querySelector('#identifiant')
    const passwordField = document.querySelector('#password')
    if (loginField && passwordField) {
      this.log('info', 'Found credentials fields, adding submit listener')
      const login = loginField.value
      const password = passwordField.value
      const event = 'loginSubmit'
      const payload = { login, password }
      this.bridge.emit('workerEvent', {
        event,
        payload
      })
    } else {
      this.log('warn', 'Cannot find credentials fields, check the code')
    }
  }

  async ensureAuthenticated({ account }) {
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    return true
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(loginFormUrl)
    await this.waitForElementInWorker('#identifiant')
  }

  async checkAuthenticated() {
    // Logout button does not exists until the menu has been clicked
    // So to check authentication, we're waiting for all major elements to be completly loaded
    const messagesElement = document.querySelector('#messages')
    const notificationsElement = document.querySelector('#notifications')
    const projectElement = document.querySelector('#step4')
    return Boolean(messagesElement && notificationsElement && projectElement)
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    const credentials = await this.getCredentials()
    const credentialsLogin = credentials?.login
    const storeLogin = this.store?.userCredentials?.login
    let sourceAccountIdentifier = credentialsLogin || storeLogin
    if (!sourceAccountIdentifier) {
      throw new Error('Could not get a sourceAccountIdentifier')
    }
    return {
      sourceAccountIdentifier: sourceAccountIdentifier
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.waitForElementInWorker('[pause]')
    const identity = await this.runInWorker('parseIdentity')
    await this.saveIdentity(identity)
  }
}

const connector = new PoleemploiContentScript({ requestInterceptor })
connector.init({ additionalExposedMethodsNames: [] }).catch(err => {
  log.warn(err)
})

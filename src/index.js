import {
  ContentScript,
  RequestInterceptor
} from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('poleemploiCCC')

const requestInterceptor = new RequestInterceptor([
  // {
  //   identifier: 'userIdentity',
  //   method: 'GET',
  //   url: '/cesuwebdec/employeursIdentite/',
  //   serialization: 'json'
  // }
])
requestInterceptor.init()

class PoleemploiContentScript extends ContentScript {
  onWorkerEvent({ event, payload }) {
    // if (event === 'loginSubmit') {
    //   this.log('info', 'received loginSubmit, blocking user interactions')
    //   this.blockWorkerInteractions()
    // } else if (event === 'loginError') {
    //   this.log(
    //     'info',
    //     'received loginError, unblocking user interactions: ' + payload?.msg
    //   )
    //   this.unblockWorkerInteractions()
    // }
  }

  onWorkerReady() {
    // window.addEventListener('DOMContentLoaded', () => {
    //   const button = document.querySelector('input[type=submit]')
    //   if (button) {
    //     button.addEventListener('click', () =>
    //       this.bridge.emit('workerEvent', { event: 'loginSubmit' })
    //     )
    //   }
    //   const error = document.querySelector('.error')
    //   if (error) {
    //     this.bridge.emit('workerEvent', {
    //       event: 'loginError',
    //       payload: { msg: error.innerHTML }
    //     })
    //   }
    // })
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

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(baseUrl)
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

  async checkAuthenticated() {
    return Boolean(document.querySelector(logoutLinkSelector))
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    const identity = await this.runInWorker('parseIdentity')
    await this.saveIdentity(identity)
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    return {
      sourceAccountIdentifier: 'defaultTemplateSourceAccountIdentifier'
    }
  }
}

const connector = new PoleemploiContentScript({ requestInterceptor })
connector.init({ additionalExposedMethodsNames: [] }).catch(err => {
  log.warn(err)
})

/* eslint-disable no-console */
import {
  ContentScript,
  RequestInterceptor
} from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import ky from 'ky'
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
  },
  {
    identifier: 'userMessages',
    method: 'GET',
    url: '/documents-usager/v2/courriers?nbElements',
    serialization: 'json'
  }
])
requestInterceptor.init()

const PDF_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/pdf'
}
const ATTESTATION_HEADERS = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  Referer:
    'https://candidat.francetravail.fr/candidat/situationadministrative/suiviinscription/attestation/recapitulatif',
  Host: 'candidat.francetravail.fr',
  'Accept-Language': 'fr-FR,fr;q=0.8,en-US;q=0.5,en;q=0.3',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': 1,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  Priority: 'u=0, i'
}

// const baseUrl = 'https://www.francetravail.fr/accueil/'
const loginFormUrl = 'https://candidat.francetravail.fr/espacepersonnel/'
const attestationsPageUrl =
  'https://candidat.pole-emploi.fr/candidat/situationadministrative/suiviinscription/attestation/mesattestations/true'
const courriersPageUrl =
  'https://authentification-candidat.pole-emploi.fr/compte/redirigervers?url=https://courriers.pole-emploi.fr/courriersweb/acces/AccesCourriers'

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
      const { identifier } = payload
      this.log('debug', `${identifier} request intercepted`)
      this.store[identifier] = { payload }
      if (identifier === 'userMessages') {
        this.store.token = payload.requestHeaders.Authorization
      }
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
    await this.clickAndWait(
      '#step1-candidat > div > button',
      'button[data-target="#PopinDeconnexion"]'
    )
    await this.clickAndWait(
      'button[data-target="#PopinDeconnexion"]',
      '.modal-footer'
    )
    await this.runInWorker('click', 'button[data-target="#PopinDeconnexion"]')
    await this.waitForElementInWorker('button', {
      includesText: 'Quitter mon espace'
    })
    await this.runInWorker('click', 'button', {
      includesText: 'Quitter mon espace'
    })
    await this.waitForElementInWorker('#keywords-selectized')
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
    const notificationsElement = document.querySelector('#notifications')
    const projectElement = document.querySelector('#step4')
    return Boolean(notificationsElement && projectElement)
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
    const courriers = await this.fetchMessages()
    await this.saveFiles(courriers, {
      context,
      fileIdAttributes: ['vendorRef'],
      contentType: 'application/pdf',
      qualificationLabel: 'unemployment_benefit'
    })
    const attestations = await this.fetchAttestations()
    await this.saveFiles([attestations], {
      context,
      fileIdAttributes: ['vendorRef'],
      contentType: 'application/pdf',
      qualificationLabel: 'employment_center_certificate'
    })
    await this.waitForElementInWorker('[pause]')
    const identity = await this.runInWorker('parseIdentity')
    await this.saveIdentity(identity)
  }

  async fetchMessages() {
    this.log('info', '📍️ fetchMessages starts')
    await this.goto(courriersPageUrl)
    await this.waitForElementInWorker('.courriers')
    const interceptedMessages = this.store.userMessages.payload.response
    const computedMessages = await this.computeMessages(
      interceptedMessages.ressources
    )
    return computedMessages
  }

  async computeMessages(messages) {
    this.log('info', '📍️ computeMessages starts')
    const computedMessages = []
    for (const message of messages) {
      const dateArray = message.dateDiffusion.match(/(.{4})(.{2})(.{2})/)
      const date = `${dateArray[1]}-${dateArray[2]}-${dateArray[3]}`
      const type = message.lmod
      const courriersUrl =
        'https://api.pole-emploi.fr/documents-usager/v2/courriers/'
      const vendorRef = message.idDn
      const fileurl = `${courriersUrl}${vendorRef}`

      const computedMessage = {
        date,
        type,
        fileurl,
        vendorRef,
        filename: `${date}_polemploi_${type}_${vendorRef}.pdf`,
        vendor: 'Pole Emploi',
        fileAttributes: {
          metadata: {
            contentAuthor: 'pole-emploi.fr',
            carbonCopy: true,
            issueDate: new Date(date)
          }
        },
        requestOptions: {
          headers: {
            Authorization: this.store.token,
            ...PDF_HEADERS
          }
        }
      }
      computedMessages.push(computedMessage)
    }
    return computedMessages
  }

  async fetchAttestations() {
    this.log('info', '📍️ fetchAttestations starts')
    await this.goto(attestationsPageUrl)
    await this.waitForElementInWorker('#attestationsSelectModel')
    await this.evaluateInWorker(() => {
      document.querySelector('#attestationsSelectModel').value =
        'AVIS_DE_SITUATION'
    })
    await this.clickAndWait('#valider', '#telechargerAttestationPdf')
    const attestation = await this.runInWorker('computeAttestation')
    return attestation
  }

  async computeAttestation() {
    this.log('info', '📍️ computeAttestation starts')
    const blob = await ky
      .get(
        'https://candidat.francetravail.fr/candidat/situationadministrative/suiviinscription/attestation/recapitulatif:telechargerattestationpdf',
        {
          headers: {
            ...ATTESTATION_HEADERS
          }
        }
      )
      .blob()
    const dataUri = await blobToBase64(blob)
    const today = new Date()
    const formattedDate = formatDate(today)
    const situationReport = {
      date: new Date(),
      shouldReplaceFile: () => true,
      filename: `${formattedDate}_polemploi_Dernier avis de situation.pdf`,
      dataUri,
      vendorRef: 'AVIS_DE_SITUATION',
      vendor: 'Pole Emploi',
      fileAttributes: {
        metadata: {
          contentAuthor: 'pole-emploi.fr',
          carbonCopy: true,
          issueDate: new Date()
        }
      }
    }
    return situationReport
  }
}

const connector = new PoleemploiContentScript({ requestInterceptor })
connector
  .init({ additionalExposedMethodsNames: ['computeAttestation'] })
  .catch(err => {
    log.warn(err)
  })

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

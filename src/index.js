/* eslint-disable no-console */
import {
  ContentScript,
  RequestInterceptor
} from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
const log = Minilog('ContentScript')
Minilog.enable('poleemploiCCC')

// Necessary here because they are using these functions and they are not supported by the webview
console.group = function () {}
console.groupCollapsed = function () {}
console.groupEnd = function () {}

const requestInterceptor = new RequestInterceptor([
  {
    identifier: 'userCoordinates',
    method: 'GET',
    url: '/moyenscontactindividu/coordonnees',
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

const NEWVER_PDF_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/pdf'
}
// const OLDVER_PDF_HEADERS = {
//   Accept: '*/*'
// }

const baseUrl = 'https://www.francetravail.fr/accueil/'
const loginFormUrl = 'https://candidat.francetravail.fr/espacepersonnel/'
const attestationsPageUrl =
  'https://candidat.pole-emploi.fr/candidat/situationadministrative/suiviinscription/attestation/mesattestations/true'
const courriersPageUrl =
  'https://authentification-candidat.pole-emploi.fr/compte/redirigervers?url=https://courriers.pole-emploi.fr/courriersweb/acces/AccesCourriers'
const coordonneesUrl =
  'https://candidat.francetravail.fr/informationscontact/coordonnees'

class PoleemploiContentScript extends ContentScript {
  async onWorkerReady() {
    await this.waitForElementNoReload.bind(this)('#password')
    const submitButton = document.querySelector('#submit')
    // Using classic event won't work properly, as all events only return "isTrusted" value
    // When submitting the form, the submit button mutates to disable itself and adds a spinner while waiting for the server response
    // Using this we ensure the user actually submits the loginForm
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
    } else {
      this.log(
        'warn',
        'MutationObserver dont exists, credentials cannot be intercepted'
      )
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
    const credentials = await this.getCredentials()
    if (!account || !credentials) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      if (credentials) {
        await this.autoLogin(credentials)
        await this.runInWorkerUntilTrue({
          method: 'waitForAuthenticated'
        })
      } else {
        this.log('info', 'Not authenticated')
        await this.showLoginFormAndWaitForAuthentication()
      }
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
    await this.waitForElementInWorker('#identifiant, #step1-candidat')
  }

  async autoLogin(credentials) {
    this.log('info', '📍️ autoLogin scredentialstarts')
    const loginInputSelector = '#identifiant'
    const passwordInputSelector = '#password'
    const submitButton = '#submit'
    await this.waitForElementInWorker(loginInputSelector)
    this.log('debug', 'Fill login field')
    await this.runInWorker('fillText', loginInputSelector, credentials.login)
    await this.runInWorker('click', submitButton)

    this.log('debug', 'Wait for password field')
    await this.waitForElementInWorker(passwordInputSelector)

    this.log('debug', 'Fill password field')
    await this.runInWorker(
      'fillText',
      passwordInputSelector,
      credentials.password
    )
    await this.runInWorker('click', submitButton)
  }

  async checkAuthenticated() {
    // There is a new version of the application being deployed, gotta handle every case, "app-accueil" being common in both known cases.
    const appHomeElement = document.querySelector('app-accueil')
    // Old version used element
    const projectElement = document.querySelector('#step4')
    // Every accounts may have differents homePage presentation (depending on the user status) so we're checking all of main elements
    const situationElement = document.querySelector('app-situation')
    const echangesElement = document.querySelector('app-mes-echanges')
    const directAccessElement = document.querySelector('app-acces-directs')
    if (appHomeElement && projectElement) {
      this.log('info', 'Old version of homePage')
      return true
    }
    if (
      appHomeElement &&
      (situationElement || echangesElement || directAccessElement)
    ) {
      this.log('info', 'New version of the homePage')
      return true
    }
    return false
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
    let sourceAccountIdentifier
    let validSAI
    if (!credentialsLogin && !storeLogin) {
      this.log('info', 'No credentials found for SAI, getting it from website')
      validSAI = await this.getSAIFromWebsite()
    }
    sourceAccountIdentifier = credentialsLogin || storeLogin || validSAI
    if (!sourceAccountIdentifier) {
      throw new Error('Could not get a sourceAccountIdentifier')
    }
    return {
      sourceAccountIdentifier: sourceAccountIdentifier
    }
  }

  async getSAIFromWebsite() {
    this.log('info', '📍️ getSAIFromWebsite starts')
    await this.clickAndWait(
      'a[href="/tableaudebord/moncompte"]',
      '.info-content'
    )
    return await this.evaluateInWorker(() => {
      return document.querySelector('.info-content').textContent
    })
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
    this.log('info', `attestations : ${JSON.stringify(attestations)}`)
    await this.saveFiles([attestations], {
      context,
      fileIdAttributes: ['vendorRef'],
      contentType: 'application/pdf',
      qualificationLabel: 'employment_center_certificate'
    })
    const identity = await this.fetchIdentity()
    await this.saveIdentity(identity)
  }

  async fetchMessages() {
    this.log('info', '📍️ fetchMessages starts')
    await this.goto(courriersPageUrl)
    // We noticed accounts can be presented differently depending on user (precise reason is not clear yet)
    await this.waitForElementInWorker('.courriers, #boutonLancerRecherche')
    if (await this.isElementInWorker('.courriers')) {
      const interceptedMessages = this.store.userMessages.payload.response
      const computedMessages = await this.computeMessages(
        interceptedMessages.ressources
      )
      return computedMessages
    } else {
      const scrapedMessages = await this.fetchMessagesWithScraping()
      return scrapedMessages
    }
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
            ...NEWVER_PDF_HEADERS
          }
        }
      }
      computedMessages.push(computedMessage)
    }
    return computedMessages
  }

  async fetchMessagesWithScraping() {
    this.log('info', '📍️ fetchMessagesWithScraping starts')
    await this.runInWorker('fillDateForm')
    await this.clickAndWait('#boutonLancerRecherche', '.listingPyjama')
    const messages = await this.runInWorker('scrapeMessages')
    const filesWithDataUri = []
    for (const message of messages) {
      const buttonSelector = `a[href*="/courriersweb/mescourriers.bloclistecourriers.boutontelecharger/${message.vendorRef}"]`
      await this.clickAndWait(buttonSelector, 'embed')
      const dataUriMessage = this.runInWorker('getFilesDataUri', message)
      this.log('info', `messages : ${JSON.stringify(dataUriMessage)}`)
    }
    return filesWithDataUri
  }

  async fillDateForm() {
    this.log('info', '📍️ fillDateForm starts')
    const startDateElement = document.querySelector('#dateDebut')
    const formStartDate = startDateElement.value
    const splittedDate = formStartDate.split('/')
    const targetStartYear = parseInt(splittedDate[2]) - 10
    const targetStartDate = `${splittedDate[0]}/${splittedDate[1]}/${targetStartYear}`
    startDateElement.value = targetStartDate
  }

  async scrapeMessages() {
    this.log('info', '📍️ scrapeMessages starts')
    const computedMessages = []
    const allMessagesElements = document
      .querySelector('tbody')
      .querySelectorAll('tr')
    for (const messageElement of allMessagesElements) {
      const date = messageElement.querySelector('.date').textContent
      const type = messageElement.querySelector('.avisPaie').textContent
      // href found here is the one for requesting the page that gets redirects, It's only use to get the vendorRef
      const buttonElement = messageElement.querySelector('.Telechar > a')
      const buttonHref = buttonElement.getAttribute('href')
      // This is done to be able to click on the button without triggering a download
      buttonElement.setAttribute('onclick', '')
      const vendorRef = buttonHref.split('/').pop()
      const fileurl = `https://courriers.francetravail.fr/courriersweb/affichagepdf:pdf/false/${vendorRef}`
      const computedMessage = {
        buttonHref,
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
        }
      }
      computedMessages.push(computedMessage)
    }
    return computedMessages
  }

  async getFilesDataUri(message) {
    this.log('info', '📍️ getFilesDataUri starts')
    const response = await fetch(message.fileurl)
    const blob = await response.blob()
    const dataUri = await blobToBase64(blob)
    const fileWithDataUri = {
      ...message,
      dataUri
    }
    delete fileWithDataUri.fileurl
    delete fileWithDataUri.buttonHref

    return fileWithDataUri
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
    const response = await fetch(
      'https://candidat.francetravail.fr/candidat/situationadministrative/suiviinscription/attestation/recapitulatif:telechargerattestationpdf'
    )
    const blob = await response.blob()
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

  async fetchIdentity() {
    this.log('info', '📍️ fetchIdentity starts')
    await this.goto(coordonneesUrl)
    await this.waitForElementInWorker('app-label-value')
    const identity = await this.computeIdentity()
    return identity
  }

  async computeIdentity() {
    this.log('info', '📍️ computeIdentity starts')
    const infos = this.store.userCoordinates.payload.response
    const result = { contact: {} }
    const firstName = infos.prenom
    const lastName = infos.nom

    result.contact.name = {
      fullName: `${firstName} ${lastName}`,
      firstName,
      lastName
    }
    result.contact.address = handleAddress(infos)
    result.contact.email = [infos.email]
    // Here we're assuming we will have a max of 2 numbers -mobile and fix-, if we only get one, it is handled in the function
    result.contact.phone = handlePhones([infos.telephone1, infos.telephone2])
    return result
  }
}

const connector = new PoleemploiContentScript({ requestInterceptor })
connector
  .init({
    additionalExposedMethodsNames: [
      'computeAttestation',
      'fillDateForm',
      'scrapeMessages',
      'getFilesDataUri'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function handlePhones(phones) {
  const result = []
  for (const phone of phones) {
    if (phone !== undefined) {
      result.push({
        type:
          phone.startsWith('06') || phone.startsWith('07') ? 'mobile' : 'home',
        number: phone
      })
    }
  }
  return result
}

function handleAddress(infos) {
  let adresses = []

  // We can find keys like "adresse4" in the interception
  // Assuming it goes down to 1 and maybe up to 5 or 6 we need to cover all cases
  // So we're checking all keys containing "adresse" with a number a format it all in one string
  for (let key in infos) {
    // Vérifie si la clé commence par "adresse" et est suivie d'un chiffre
    if (key.startsWith('adresse') && !isNaN(key.slice(7))) {
      adresses.push({ key, value: infos[key] })
    }
  }
  adresses.sort((a, b) => parseInt(a.key.slice(7)) - parseInt(b.key.slice(7)))

  const formattedValues = adresses.map(ad => ad.value).join(' ')
  const postCode = infos.codePostal
  const city = infos.libelleCommune
  const country = infos.libellePays

  const foundAddress = {
    formattedAddress: `${formattedValues}, ${postCode} ${city} ${country}`,
    postCode,
    city,
    country
  }
  return [foundAddress]
}

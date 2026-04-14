import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'
import logger from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let driveClient = null

async function getDrive() {
  if (driveClient) return driveClient

  const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    ? path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH)
    : path.resolve(__dirname, '../../config/service-account.json')

  const credentials = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'))
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  })

  driveClient = google.drive({ version: 'v3', auth })
  return driveClient
}

/**
 * F-08: スクショをGoogle Driveに保存
 *
 * @param {Object} params
 * @param {string} params.screenshotBase64 - PNG画像のBase64文字列
 * @param {string} params.companyName - ファイル名に使用
 * @param {string} params.folderId - 保存先フォルダID（未設定なら GOOGLE_DRIVE_FOLDER_ID 環境変数）
 * @returns {Promise<{fileId: string, fileUrl: string}>}
 */
export async function uploadScreenshot({ screenshotBase64, companyName, folderId }) {
  const drive = await getDrive()
  const targetFolderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID

  const timestamp = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).replace(/[/:]/g, '').replace(/\s/g, '_')

  const fileName = `${sanitizeFileName(companyName)}_${timestamp}.png`
  const buffer = Buffer.from(screenshotBase64, 'base64')
  const stream = Readable.from(buffer)

  try {
    const metadata = {
      name: fileName,
      mimeType: 'image/png',
      ...(targetFolderId ? { parents: [targetFolderId] } : {})
    }

    const response = await drive.files.create({
      requestBody: metadata,
      media: { mimeType: 'image/png', body: stream },
      fields: 'id, webViewLink'
    })

    const fileId = response.data.id
    const fileUrl = response.data.webViewLink

    logger.info(`✅ Drive保存: ${fileName} | ${fileUrl}`)
    return { fileId, fileUrl, fileName }
  } catch (error) {
    logger.error(`Drive保存エラー: ${companyName}`, { error: error.message })
    throw error
  }
}

/**
 * 送信記録用フォルダを自動作成
 */
export async function ensureDriveFolder(folderName = '送信スクショ') {
  const drive = await getDrive()

  // 既存フォルダを検索
  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)'
  })

  if (res.data.files?.length > 0) {
    logger.info(`Driveフォルダ確認: ${folderName} (${res.data.files[0].id})`)
    return res.data.files[0].id
  }

  // フォルダ新規作成
  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id'
  })

  logger.info(`Driveフォルダ作成: ${folderName} (${folder.data.id})`)
  return folder.data.id
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50)
}

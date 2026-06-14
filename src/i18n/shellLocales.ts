/**
 * Canonical translations of SHELL_STRINGS (Settings / About / common actions)
 * in the canon § Translations locale set (es, de, fr, it, pt-BR, ja). Because
 * the shell chrome is identical across every app, translating it ONCE here
 * localizes the Settings/About of every shell app — no per-app work. Synced by
 * `sync.mjs app-shell` (overwrite); edit HERE, never per app.
 *
 * Voice canon applies in every language: plain, calm, second person, no
 * marketing-ese. "Josh Approved" is a brand proper noun and never translates.
 * The app overlays its OWN domain strings per locale in `locales.ts`.
 *
 * Machine-drafted (Claude, $0 — canon § Translations). A native per-locale
 * layout/quality pass rides the Tier-3 capture machinery before these are
 * treated as final; the keys map 1:1 to shellStrings.ts.
 */

export const SHELL_LOCALES = {
  es: {
    common: { back: 'Atrás', cancel: 'Cancelar', done: 'Hecho', save: 'Guardar', delete: 'Eliminar', edit: 'Editar', rename: 'Cambiar nombre', add: 'Añadir' },
    settings: { title: 'Ajustes', themeSystem: 'Sistema', themeLight: 'Claro', themeDark: 'Oscuro', language: 'Idioma', languageSystem: 'Sistema', languageSystemHint: 'Según tu teléfono', yourData: 'Tus datos', about: 'Acerca de', export: 'Exportar', import: 'Importar', nothingImported: 'No se importó nada.', couldntExport: 'No se pudo exportar.', couldntRead: 'No se pudo leer ese archivo.' },
    about: { support: 'Apoyar esta app', feedback: 'Enviar comentarios', review: 'Dejar una reseña', privacy: 'Privacidad', source: 'Código fuente', acknowledgements: 'Agradecimientos', version: 'Versión', oneLiner: 'Alternativas centradas en la privacidad a las apps de utilidades con muros de pago. Código abierto. Paga lo que quieras.', learnMore: 'Más información' },
  },
  de: {
    common: { back: 'Zurück', cancel: 'Abbrechen', done: 'Fertig', save: 'Speichern', delete: 'Löschen', edit: 'Bearbeiten', rename: 'Umbenennen', add: 'Hinzufügen' },
    settings: { title: 'Einstellungen', themeSystem: 'System', themeLight: 'Hell', themeDark: 'Dunkel', language: 'Sprache', languageSystem: 'System', languageSystemHint: 'Wie dein Telefon', yourData: 'Deine Daten', about: 'Über', export: 'Exportieren', import: 'Importieren', nothingImported: 'Nichts importiert.', couldntExport: 'Export fehlgeschlagen.', couldntRead: 'Diese Datei konnte nicht gelesen werden.' },
    about: { support: 'Diese App unterstützen', feedback: 'Feedback senden', review: 'Bewertung abgeben', privacy: 'Datenschutz', source: 'Quellcode', acknowledgements: 'Danksagungen', version: 'Version', oneLiner: 'Datenschutzfreundliche Alternativen zu Utility-Apps mit Bezahlschranke. Open Source. Zahl, was du willst.', learnMore: 'Mehr erfahren' },
  },
  fr: {
    common: { back: 'Retour', cancel: 'Annuler', done: 'Terminé', save: 'Enregistrer', delete: 'Supprimer', edit: 'Modifier', rename: 'Renommer', add: 'Ajouter' },
    settings: { title: 'Réglages', themeSystem: 'Système', themeLight: 'Clair', themeDark: 'Sombre', language: 'Langue', languageSystem: 'Système', languageSystemHint: 'Selon votre téléphone', yourData: 'Vos données', about: 'À propos', export: 'Exporter', import: 'Importer', nothingImported: "Rien n'a été importé.", couldntExport: "Échec de l'exportation.", couldntRead: 'Impossible de lire ce fichier.' },
    about: { support: 'Soutenir cette app', feedback: 'Envoyer un commentaire', review: 'Laisser un avis', privacy: 'Confidentialité', source: 'Code source', acknowledgements: 'Remerciements', version: 'Version', oneLiner: 'Des alternatives respectueuses de la vie privée aux applis utilitaires payantes. Open source. Payez ce que vous voulez.', learnMore: 'En savoir plus' },
  },
  it: {
    common: { back: 'Indietro', cancel: 'Annulla', done: 'Fatto', save: 'Salva', delete: 'Elimina', edit: 'Modifica', rename: 'Rinomina', add: 'Aggiungi' },
    settings: { title: 'Impostazioni', themeSystem: 'Sistema', themeLight: 'Chiaro', themeDark: 'Scuro', language: 'Lingua', languageSystem: 'Sistema', languageSystemHint: 'Come il telefono', yourData: 'I tuoi dati', about: 'Informazioni', export: 'Esporta', import: 'Importa', nothingImported: 'Niente importato.', couldntExport: 'Esportazione non riuscita.', couldntRead: 'Impossibile leggere il file.' },
    about: { support: 'Sostieni questa app', feedback: 'Invia un feedback', review: 'Lascia una recensione', privacy: 'Privacy', source: 'Codice sorgente', acknowledgements: 'Ringraziamenti', version: 'Versione', oneLiner: 'Alternative attente alla privacy alle app di utilità a pagamento. Open source. Paghi quanto vuoi.', learnMore: 'Scopri di più' },
  },
  'pt-BR': {
    common: { back: 'Voltar', cancel: 'Cancelar', done: 'Concluído', save: 'Salvar', delete: 'Excluir', edit: 'Editar', rename: 'Renomear', add: 'Adicionar' },
    settings: { title: 'Configurações', themeSystem: 'Sistema', themeLight: 'Claro', themeDark: 'Escuro', language: 'Idioma', languageSystem: 'Sistema', languageSystemHint: 'Conforme seu telefone', yourData: 'Seus dados', about: 'Sobre', export: 'Exportar', import: 'Importar', nothingImported: 'Nada importado.', couldntExport: 'Não foi possível exportar.', couldntRead: 'Não foi possível ler esse arquivo.' },
    about: { support: 'Apoiar este app', feedback: 'Enviar feedback', review: 'Avaliar', privacy: 'Privacidade', source: 'Código-fonte', acknowledgements: 'Agradecimentos', version: 'Versão', oneLiner: 'Alternativas com foco em privacidade a apps utilitários com paywall. Código aberto. Pague o quanto quiser.', learnMore: 'Saiba mais' },
  },
  ja: {
    common: { back: '戻る', cancel: 'キャンセル', done: '完了', save: '保存', delete: '削除', edit: '編集', rename: '名前を変更', add: '追加' },
    settings: { title: '設定', themeSystem: 'システム', themeLight: 'ライト', themeDark: 'ダーク', language: '言語', languageSystem: 'システム', languageSystemHint: 'スマホに合わせる', yourData: 'あなたのデータ', about: 'アプリについて', export: 'エクスポート', import: 'インポート', nothingImported: 'インポートされませんでした。', couldntExport: 'エクスポートできませんでした。', couldntRead: 'そのファイルを読み込めませんでした。' },
    about: { support: 'このアプリを支援', feedback: 'フィードバックを送る', review: 'レビューを書く', privacy: 'プライバシー', source: 'ソースコード', acknowledgements: '謝辞', version: 'バージョン', oneLiner: '有料の実用アプリに代わる、プライバシー重視のオープンソースアプリ。料金はお気持ちで。', learnMore: '詳しく見る' },
  },
} as const;

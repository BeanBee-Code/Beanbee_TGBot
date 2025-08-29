import { translations, Language } from './translations';
import { UserModel } from '@/database/models/User';
import { Context } from 'telegraf';

export { Language } from './translations';

export async function getUserLanguage(telegramId: number): Promise<Language> {
  const user = await UserModel.findOne({ telegramId });
  return (user?.language || 'en') as Language;
}

export async function setUserLanguage(telegramId: number, language: Language): Promise<void> {
  await UserModel.findOneAndUpdate(
    { telegramId },
    { language },
    { upsert: true }
  );
}

export function t(language: Language, path: string, params?: Record<string, any>): string {
  const keys = path.split('.');
  let result: any = translations[language];
  
  for (const key of keys) {
    result = result?.[key];
    if (result === undefined) {
      // Fallback to English if translation is missing
      result = translations.en;
      for (const k of keys) {
        result = result?.[k];
      }
      break;
    }
  }
  
  const template = result || path;
  return params ? interpolate(template, params) : template;
}

export async function getTranslation(ctx: Context, path: string, params?: Record<string, any>): Promise<string> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return t('en', path, params);
  
  const language = await getUserLanguage(telegramId);
  return t(language, path, params);
}

// Helper function to interpolate template strings
export function interpolate(template: string, params: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match;
  });
}


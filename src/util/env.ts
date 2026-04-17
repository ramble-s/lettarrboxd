import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LETTERBOXD_URL: z.string().url(),
  RADARR_API_URL: z.string(),
  RADARR_API_KEY: z.string(),
  RADARR_QUALITY_PROFILE: z.string(),
  RADARR_MINIMUM_AVAILABILITY: z.string().default('released'),
  RADARR_ROOT_FOLDER_ID: z.string().optional(),
  RADARR_TAGS: z.string().optional(),
  RADARR_ADD_UNMONITORED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  CHECK_INTERVAL_MINUTES: z.string().default('10').transform(Number).pipe(z.number().min(10)),
  LETTERBOXD_TAKE_AMOUNT: z.string().optional().transform(val => val ? Number(val) : undefined).pipe(z.number().positive().optional()),
  LETTERBOXD_TAKE_STRATEGY: z.enum(['oldest', 'newest']).optional(),
  DRY_RUN: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  SONARR_ENABLED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  SONARR_API_URL: z.string().optional(),
  SONARR_API_KEY: z.string().optional(),
  SONARR_QUALITY_PROFILE: z.string().optional(),
  TMDB_API_KEY: z.string().optional(),
  LETTERBOXD_CLEANUP_ENABLED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  LETTERBOXD_USERNAME: z.string().optional(),
  LETTERBOXD_CLEANUP_TAG: z.string().default('cleanup'),
}).refine(data => {
  const hasTakeAmount = data.LETTERBOXD_TAKE_AMOUNT !== undefined;
  const hasTakeStrategy = data.LETTERBOXD_TAKE_STRATEGY !== undefined;

  if (hasTakeAmount && !hasTakeStrategy) return false;
  if (hasTakeStrategy && !hasTakeAmount) return false;
  return true;
}, {
  message: "When using movie limiting, both LETTERBOXD_TAKE_AMOUNT and LETTERBOXD_TAKE_STRATEGY must be specified",
  path: ["LETTERBOXD_TAKE_AMOUNT", "LETTERBOXD_TAKE_STRATEGY"]
}).refine(data => {
  if (!data.SONARR_ENABLED) return true;
  return !!(data.SONARR_API_URL && data.SONARR_API_KEY && data.SONARR_QUALITY_PROFILE && data.TMDB_API_KEY);
}, {
  message: "SONARR_API_URL, SONARR_API_KEY, SONARR_QUALITY_PROFILE, and TMDB_API_KEY are required when SONARR_ENABLED=true",
  path: ["SONARR_ENABLED"]
}).refine(data => {
  if (!data.LETTERBOXD_CLEANUP_ENABLED) return true;
  return !!data.LETTERBOXD_USERNAME;
}, {
  message: "LETTERBOXD_USERNAME is required when LETTERBOXD_CLEANUP_ENABLED=true",
  path: ["LETTERBOXD_CLEANUP_ENABLED"]
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    console.error('Environment validation failed:');
    result.error.issues.forEach(error => {
      console.error(`- ${error.path.join('.')}: ${error.message}`);
    });
    process.exit(1);
  }
  
  return result.data;
}

const env = validateEnv();
export default env;
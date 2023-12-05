import { DefaultApi, Configuration } from "./generated";
import Redis from "ioredis";
import { promisify } from "util";
// @ts-ignore
import { Client as CastClient, DefaultMediaReceiver } from "castv2-client";
import {
  Client as DiscordClient,
  SlashCommandBuilder,
  REST as DiscordRest,
  Routes,
} from "discord.js";
import axios from "axios";

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue === undefined) {
      throw new Error(`Environment variable "${key}" is not defined.`);
    }
    return defaultValue;
  }
  return value;
}

function unwrap<T>(val: T | undefined): T {
  if (val === undefined) {
    throw new Error("value is undefined.");
  }
  return val;
}

const natureRemoToken = getEnv("NATURE_REMO_TOKEN");
const deviceId = getEnv("DEVICE_ID");
const redisUrl = getEnv("REDIS_URL");
const castHost = getEnv("CAST_HOST");
const contentUrl = getEnv("CONTENT_URL");
const volume = Number(getEnv("VOLUME", "0.5"));
const discordToken = getEnv("DISCORD_TOKEN");
const discordAppId = getEnv("DISCORD_APP_ID");
const discordGuildId = getEnv("DISCORD_GUILD_ID");
const discordWebhookUrl = getEnv("DISCORD_WEBHOOK_URL");
const countThreshold = Number(getEnv("COUNT_THRESHOLD", "5"));
const durationThreshold = Number(getEnv("DURATION_THRESHOLD", "15"));

const client = new DefaultApi(
  new Configuration({
    accessToken: natureRemoToken,
  })
);
const redis = new Redis(redisUrl);

const ALLOW_SLEEP_UNTIL = "allow_sleep_until";
const DETECTED_ATS = "detected_ats";
const interval = 1;

const discordClient = new DiscordClient({
  intents: [],
});
const commands = [
  new SlashCommandBuilder()
    .setName("allow_sleep")
    .setDescription("指定した時間まで睡眠を許可する")
    .addStringOption((option) =>
      option
        .setName("duration")
        .setDescription("許可する時間（例: 9:00, 7h, 30m)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("disallow_sleep")
    .setDescription("睡眠許可を解除する"),
].map((command) => command.toJSON());

discordClient.on("ready", () => {});

discordClient.on("interactionCreate", async (interaction) => {
  if (interaction.isCommand()) {
    if (interaction.commandName === "allow_sleep") {
      const now = new Date();
      const durationStr = interaction.options.get("duration", true).value;
      if (typeof durationStr !== "string") {
        throw new Error("duration is not string");
      }
      const until = (() => {
        if (durationStr.match(/^\d+m$/)) {
          const minutes = Number(durationStr.slice(0, -1));
          return new Date(now.getTime() + minutes * 60 * 1000);
        } else if (durationStr.match(/^\d+h$/)) {
          const hours = Number(durationStr.slice(0, -1));
          return new Date(now.getTime() + hours * 60 * 60 * 1000);
        } else if (durationStr.match(/^\d+:\d+$/)) {
          const result = new Date(now.getTime());
          const [hourStr, minuteStr] = durationStr.split(":");
          result.setHours(Number(hourStr));
          result.setMinutes(Number(minuteStr));
          result.setSeconds(0);
          result.setMilliseconds(0);
          if (result < now) {
            result.setDate(result.getDate() + 1);
          }
          return result;
        } else {
          throw new Error("duration is invalid");
        }
      })();
      await redis.set(ALLOW_SLEEP_UNTIL, until.toISOString());
      await interaction.reply(
        `${until.toLocaleString()} まで睡眠を許可しました。`
      );
    }
    if (interaction.commandName === "disallow_sleep") {
      await redis.del(ALLOW_SLEEP_UNTIL);
      await interaction.reply("睡眠許可を解除しました。");
    }
  }
});

async function run() {
  const now = new Date();

  const device = (await client._1devicesGet()).data.find(
    (device) => device.id === deviceId
  );
  if (device === undefined) {
    throw new Error(`Device "${deviceId}" is not found.`);
  }

  const detectedAts: string[] = JSON.parse(
    (await redis.get(DETECTED_ATS)) ?? "[]"
  );
  const detectedAtStr = device.newest_events?.mo?.created_at;
  if (detectedAtStr === undefined) {
    console.log("No motion detected.");
    return;
  }
  const detectedAt = new Date(detectedAtStr).toISOString();
  if (!detectedAts.includes(detectedAt)) {
    console.log(`Motion detected at ${detectedAt}`);
    detectedAts.push(detectedAt);
  }

  // 過去N分以内に検知されたものだけを残す
  const filteredDetectedAts = detectedAts.filter(
    (detectedAtStr) =>
      new Date(detectedAtStr).getTime() + durationThreshold * 60 * 1000 >
      now.getTime()
  );

  if (filteredDetectedAts.length != 0) {
    console.log(
      `Detected at count past ${durationThreshold} minutes: ${filteredDetectedAts.length}`
    );
  }
  // 過去N分でM回以上反応していたら寝ている判定
  if (filteredDetectedAts.length < countThreshold) {
    await redis.set(DETECTED_ATS, JSON.stringify(filteredDetectedAts));
    return;
  }
  // 睡眠許可中なら何もしない
  const allowSleepUntilStr = await redis.get(ALLOW_SLEEP_UNTIL);
  if (allowSleepUntilStr !== null) {
    const allowSleepUntil = new Date(allowSleepUntilStr);
    if (allowSleepUntil > now) {
      return;
    } else {
      await redis.del(ALLOW_SLEEP_UNTIL);
    }
  }
  await redis.del(DETECTED_ATS);
  await axios.post(discordWebhookUrl, {
    content: `睡眠が検知されました`,
  });

  const castClient = new CastClient();
  castClient.on("error", (err: any) => {
    console.error(err);
    castClient.close();
  });
  await promisify((cb) => castClient.connect(castHost, cb))();
  const player: any = await promisify((cb) =>
    castClient.launch(DefaultMediaReceiver, cb)
  )();
  await promisify((cb) => castClient.setVolume({ level: volume }, cb))();
  await promisify((cb) =>
    player.load({ contentId: contentUrl }, { autoplay: true }, cb)
  )();
}

async function main() {
  console.log("起動");
  const rest = new DiscordRest({ version: "10" }).setToken(discordToken);
  await rest.put(
    Routes.applicationGuildCommands(discordAppId, discordGuildId),
    {
      body: commands,
    }
  );
  discordClient.login(discordToken);

  while (true) {
    try {
      await run();
    } catch (e) {
      console.error(e);
    }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000 * 60));
  }
}

main();

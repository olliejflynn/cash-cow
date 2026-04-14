import "./env-loader";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { json, urlencoded } from "express";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });
  const bodyLimit = process.env.REQUEST_BODY_LIMIT ?? "50mb";
  app.use(
    json({
      limit: bodyLimit,
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  const config = app.get(ConfigService);
  const port = config.get<number>("port") ?? 3000;
  // Bind all interfaces (required on Railway/Docker so the edge proxy can reach the process).
  await app.listen(port, "0.0.0.0");
  console.log(
    `[bootstrap] Listening on http://0.0.0.0:${port} (process.env.PORT=${JSON.stringify(
      process.env.PORT ?? ""
    )}, body limit=${bodyLimit})`
  );
  if (process.env.RAILWAY_ENVIRONMENT && process.env.PORT === "3000") {
    console.warn(
      "[bootstrap] You set PORT=3000 on Railway. Remove the PORT variable from Railway " +
        "and let the platform assign PORT unless support told you otherwise—wrong port " +
        "routing often causes 502 from the proxy."
    );
  }
}

bootstrap();

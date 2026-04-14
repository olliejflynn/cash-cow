import "./env-loader";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { json, urlencoded } from "express";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(urlencoded({ extended: true }));
  const config = app.get(ConfigService);
  const port = config.get<number>("port") ?? 3000;
  // Bind all interfaces (required on Railway/Docker so the edge proxy can reach the process).
  await app.listen(port, "0.0.0.0");
}

bootstrap();

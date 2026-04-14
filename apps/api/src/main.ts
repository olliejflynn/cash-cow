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
  await app.listen(port);
}

bootstrap();

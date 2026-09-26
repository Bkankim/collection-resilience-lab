# 출발지 프록시(#14). 공개 tinyproxy 이미지에 기대지 않고 alpine 패키지로 만든다. 설정은 compose가 붙인다.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]

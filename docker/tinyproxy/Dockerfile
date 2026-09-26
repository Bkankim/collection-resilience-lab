# 출발지 프록시(#14). 공개 tinyproxy 이미지에 기대지 않고 alpine 패키지로 만든다.
# 설정은 이미지에 넣는다. compose의 bind mount로 붙이면 Docker VM에 공유되지 않은 경로(colima 기본은 홈만 공유)에
# clone했을 때 빈 디렉터리가 붙어 프록시가 뜨지 않는다(TROUBLESHOOTING 7번).
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import os
from dotenv import load_dotenv
from azure.identity import aio, get_bearer_token_provider, AzureCliCredential
from openai import AsyncAzureOpenAI, AzureOpenAI

from bs4 import BeautifulSoup as bs

# HACK: This file contains existing python OpenAI connection code I had access to.  It also uses
# existing python BeautifulSoup code I already had knowledge in for parsing HTML.

class PutContent(BaseModel):
    html: str

class HtmlContent(BaseModel):
    tag_searched: str
    full_content: str
    extracted_content: str

class HtmlContents(BaseModel):
    contents: list[HtmlContent] = []

# OPENAI CONNECTION
load_dotenv()

azure_openai_config = {
    "azure_endpoint": os.environ.get(f"AZURE_OPENAI_ENDPOINT", ""),
    "azure_deployment": os.environ.get(f"AZURE_OPENAI_DEPLOYMENT", ""),
    "api_version": os.environ.get(f"AZURE_OPENAI_API_VERSION", ""),
    "max_retries": 2,
}

model = azure_openai_config.get("azure_deployment", "gpt-4o")

async_client = AsyncAzureOpenAI(
    **azure_openai_config,
    azure_ad_token_provider = aio.get_bearer_token_provider(
        aio.AzureCliCredential(),
        "https://cognitiveservices.azure.com/.default",
    )
)

client = AzureOpenAI(
    **azure_openai_config,
    azure_ad_token_provider=get_bearer_token_provider(
        AzureCliCredential(),
        "https://cognitiveservices.azure.com/.default",
    ),
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins = ['*'],
    allow_methods = ["*"],
    allow_headers = ["*"]
)

@app.put("/process_html")
async def process_html(put_content: PutContent):

    def select_tags(
        html_str: str,
        wanted_tags: list[str]
    ) -> HtmlContents:
        print(f"wanted_tags: {wanted_tags}")
        soup = bs(html_str, "html.parser")

        html_contents = HtmlContents()
        for tagname in wanted_tags:
            for element in soup.select(tagname):
                html_contents.contents.append(
                    HtmlContent(tag_searched=tagname,
                    full_content=str(element),
                    extracted_content=str(element.text))
                )
        return html_contents

    async def llm_rewrite_html(content_to_transform: str, desired_reading_level: str):
        resp = await async_client.chat.completions.create(
            model="gpt-4o",
            temperature=0.0,
            messages=[
                {
                    "role": "system",
                    "content": ("The provided content is written for certain reading-level. The information is good, "
                                "but how it is written may be beyond the reading-level of some people. Your assignment"
                                f" is to transform the ORIGINAL_CONTENT to a {desired_reading_level} reading-level. "
                                "The translation you provide MUST still be accurate according to the original content "
                                f"provided. You can re-explain things or use different vocabulary to meet the {desired_reading_level}"
                                " reading-level.  But you cannot inject your own background knowledge related to the content"
                                " if it was not already present in the provided content.  For example, you can use a metaphor to "
                                "help explain a concept from the content, but you cannot add new additional data or facts about"
                                " the subject matter of the content, if not present in the original content. Do NOT change any"
                                " original quotations in the original content -- that would be altering accuracy and data. Please respond"
                                f" with your translation for a {desired_reading_level} reading-level reader. You should also strive"
                                " to keep the token count of your produced translation to be approximately the same as the token count"
                                " of the otiginal content.  Provide ONLY the translation.")
                },
                {
                    "role": "system",
                    "content": f"<ORIGINAL_CONTENT>{content_to_transform}</ORIGINAL_CONTENT>"
                },
            ],
        )

        content = resp.choices[0].message.content
        return content

    # Extract wanted content
    wanted_tags = ["p"]
    html_parsed_contents = select_tags(put_content.html, wanted_tags)

    # hacked code -- not good code, but works.
    soup = bs(put_content.html, "html.parser") # all content
    for wanted_tag in wanted_tags:
        for element in soup.select(wanted_tag): #only p
            for html_content in html_parsed_contents.contents:
                if html_content.full_content == str(element):
                    if (element.text != "\n"): #hack
                        # rewrite content using LLM
                        element.string = await llm_rewrite_html(html_content.extracted_content, "5th grade")
                    continue

    return {"processed": str(soup)}
